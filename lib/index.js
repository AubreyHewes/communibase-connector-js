'use strict';

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

var fetch = require('isomorphic-fetch');
var async = require('async');
var http = require('http');
var https = require('https');
var stream = require('stream');
var io = require('socket.io-client');
var LRU = require('lru-cache');
var Promise = require('bluebird');

function defer() {
  var deferResolve = void 0;
  var deferReject = void 0;
  var promise = new Promise(function (resolve, reject) {
    deferResolve = resolve;
    deferReject = reject;
  });
  return {
    resolve: deferResolve,
    reject: deferReject,
    promise: promise
  };
}

function CommunibaseError(data) {
  this.name = 'CommunibaseError';
  this.code = data.code || 500;
  this.message = data.message || '';
  this.errors = data.errors || {};

  Error.captureStackTrace(this, CommunibaseError);
}

CommunibaseError.prototype = Error.prototype;
/**
 * Constructor for connector.
 *
 * @param key - The communibase api key
 * @constructor
 */
var Connector = function Connector(key) {
  var _this = this;

  this.getByIdQueue = {};
  this.getByIdPrimed = false;
  this.key = key;
  this.token = '';
  this.setServiceUrl(process.env.COMMUNIBASE_API_URL || 'https://api.communibase.nl/0.1/');
  this.queue = async.queue(function (task, callback) {
    function fail(errorish) {
      var error = errorish;
      if (!(error instanceof Error)) {
        error = new CommunibaseError(error, task);
      }
      task.deferred.reject(error);
      callback();
      return null;
    }

    if (!_this.key && !_this.token) {
      fail(new Error('Missing key or token for Communibase Connector: please set COMMUNIBASE_KEY environment' + ' variable, or spawn a new instance using require(\'communibase-connector-js\').clone(\'<' + 'your api key>\')'));
      return null;
    }

    if (!task.options) {
      task.options = {};
    }
    if (!task.options.headers) {
      task.options.headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      };
    }
    if (process.env.COMMUNIBASE_API_HOST) {
      task.options.headers.Host = process.env.COMMUNIBASE_API_HOST;
    }

    if (_this.key) {
      task.options.headers['x-api-key'] = _this.key;
    }
    if (_this.token) {
      task.options.headers['x-access-token'] = _this.token;
    }
    // not support by fetch spec / whatwg-fetch
    if (task.options.query) {
      task.url += '?' + Object.keys(task.options.query).map(function (queryVar) {
        return encodeURIComponent(queryVar) + '=' + encodeURIComponent(task.options.query[queryVar]);
      }).join('&');
      task.options.query = undefined;
    }

    var success = false;
    return Promise.resolve(fetch(task.url, task.options)).then(function (response) {
      success = response.status === 200;
      return response.json();
    }).then(function (result) {
      if (success) {
        var deferred = task.deferred;
        var records = result;
        if (result.metadata && result.records) {
          deferred.promise.metadata = result.metadata;
          records = result.records;
        }
        deferred.resolve(records);
        callback();
        return null;
      }

      throw new CommunibaseError(result);
    }).catch(fail);
  }, 8);
};

// Connector.prototype.serviceUrl;
// Connector.prototype.serviceUrlIsHttps;

Connector.prototype.setServiceUrl = function (newServiceUrl) {
  if (!newServiceUrl) {
    throw new Error('Cannot set empty service-url');
  }
  this.serviceUrl = newServiceUrl;
  this.serviceUrlIsHttps = newServiceUrl.indexOf('https') === 0;
};

/**
 *
 * Bare boned search
 * @returns {Promise}
 *
 */
Connector.prototype._search = function (objectType, selector, params) {
  var deferred = defer();
  this.queue.push({
    deferred: deferred,
    url: '' + this.serviceUrl + objectType + '.json/search',
    options: {
      method: 'POST',
      body: JSON.stringify(selector),
      query: params
    }
  });
  return deferred.promise;
};

/**
 * Bare boned retrieval by objectIds
 * @returns {Promise}
 */
Connector.prototype._getByIds = function (objectType, objectIds, params) {
  return this._search(objectType, {
    _id: { $in: objectIds }
  }, params);
};

/**
 * Default object retrieval: should provide cachable objects
 */
Connector.prototype.spoolQueue = function spoolQueue() {
  var _this2 = this;

  Object.keys(this.getByIdQueue).forEach(function (objectType) {
    var deferredsById = _this2.getByIdQueue[objectType];
    var objectIds = Object.keys(deferredsById);

    _this2.getByIdQueue[objectType] = {};
    _this2._getByIds(objectType, objectIds).then(function (objects) {
      var objectHash = objects.reduce(function (previousValue, object) {
        previousValue[object._id] = object;
        return previousValue;
      }, {});
      objectIds.forEach(function (objectId) {
        if (objectHash[objectId]) {
          deferredsById[objectId].resolve(objectHash[objectId]);
          return;
        }
        deferredsById[objectId].reject(new Error(objectId + ' is not found'));
      });
    }, function (err) {
      objectIds.forEach(function (objectId) {
        deferredsById[objectId].reject(err);
      });
    });
  });
  this.getByIdPrimed = false;
};

/**
 * Get a single object by its id
 *
 * @param {string} objectType - E.g. Person
 * @param {string}objectId - E.g. 52259f95dafd757b06002221
 * @param {object} [params={}] - key/value store for extra arguments like fields, limit, page and/or sort
 * @param {string|null} [versionId=null] - optional versionId to retrieve
 * @returns {Promise} - for object: a key/value object with object data
 */
Connector.prototype.getById = function getById(objectType, objectId, params, versionId) {
  var _this3 = this;

  if (typeof objectId !== 'string' || objectId.length !== 24) {
    return Promise.reject(new Error('Invalid objectId'));
  }

  // not combinable...
  if (versionId || params && params.fields) {
    var deferred = defer();
    this.queue.push({
      deferred: deferred,
      url: '' + this.serviceUrl + objectType + '.json/' + (versionId ? 'history/' + objectId + '/' + versionId : 'crud/' + objectId),
      options: {
        method: 'GET',
        query: params
      }
    });
    return deferred.promise;
  }

  // cached?
  if (this.cache && this.cache.isAvailable(objectType, objectId)) {
    return this.cache.objectCache[objectType][objectId];
  }

  // since we are not requesting a specific version or fields, we may combine the request..?
  if (this.getByIdQueue[objectType] === undefined) {
    this.getByIdQueue[objectType] = {};
  }

  if (this.getByIdQueue[objectType][objectId]) {
    // requested twice?
    return this.getByIdQueue[objectType][objectId].promise;
  }

  this.getByIdQueue[objectType][objectId] = defer();

  if (this.cache) {
    if (this.cache.objectCache[objectType] === undefined) {
      this.cache.objectCache[objectType] = {};
    }
    this.cache.objectCache[objectType][objectId] = this.getByIdQueue[objectType][objectId].promise;
  }

  if (!this.getByIdPrimed) {
    process.nextTick(function () {
      _this3.spoolQueue();
    });
    this.getByIdPrimed = true;
  }
  return this.getByIdQueue[objectType][objectId].promise;
};

/**
 * Get an array of objects by their ids
 * If one or more entries are found, they are returned as an array of values
 *
 * @param {string} objectType - E.g. Person
 * @param {Array} objectIds - objectIds - E.g. ['52259f95dafd757b06002221']
 * @param {object} [params={}] - key/value store for extra arguments like fields, limit, page and/or sort
 * @returns {Promise} - for array of key/value objects
 */
Connector.prototype.getByIds = function (objectType, objectIds, params) {
  var _this4 = this;

  if (objectIds.length === 0) {
    return Promise.resolve([]);
  }

  // not combinable...
  if (params && params.fields) {
    return this._getByIds(objectType, objectIds, params);
  }

  return Promise.all(objectIds.map(function (objectId) {
    return _this4.getById(objectType, objectId, params).reflect();
  })).then(function (inspections) {
    var result = [];
    var error = null;
    inspections.forEach(function (inspection) {
      if (inspection.isRejected()) {
        error = inspection.reason();
        return;
      }
      result.push(inspection.value());
    });
    if (result.length) {
      return result;
    }

    if (error) {
      throw new Error(error);
    }

    // return the empty array, if no results and no error
    return result;
  });
};

/**
 * Get all objects of a certain type
 *
 * @param {string} objectType - E.g. Person
 * @param {object} [params={}] - key/value store for extra arguments like fields, limit, page and/or sort
 * @returns {Promise} - for array of key/value objects
 */
Connector.prototype.getAll = function (objectType, params) {
  if (this.cache && !(params && params.fields)) {
    return this.search(objectType, {}, params);
  }

  var deferred = defer();
  this.queue.push({
    deferred: deferred,
    url: '' + this.serviceUrl + objectType + '.json/crud',
    options: {
      method: 'GET',
      query: params
    }
  });
  return deferred.promise;
};

/**
 * Get result objectIds of a certain search
 *
 * @param {string} objectType - E.g. Person
 * @param {object} selector - { firstName: "Henk" }
 * @param {object} [params={}] - key/value store for extra arguments like fields, limit, page and/or sort
 * @returns {Promise} - for array of key/value objects
 */
Connector.prototype.getIds = function getIds(objectType, selector, params) {
  var _this5 = this;

  var hash = void 0;
  if (this.cache) {
    hash = JSON.stringify([objectType, selector, params]);
    if (!this.cache.getIdsCaches[objectType]) {
      this.cache.getIdsCaches[objectType] = LRU(1000); // 1000 getIds are this.cached, per entityType
    }
    var result = this.cache.getIdsCaches[objectType].get(hash);
    if (result) {
      return Promise.resolve(result);
    }
  }

  var resultPromise = this.search(objectType, selector, Object.assign({ fields: '_id' }, params)).then(function (results) {
    return results.map(function (result) {
      return result._id;
    });
  });

  if (this.cache) {
    resultPromise.then(function (ids) {
      _this5.cache.getIdsCaches[objectType].set(hash, ids);
      return ids;
    });
  }

  return resultPromise;
};

/**
 * Get the id of an object based on a search
 *
 * @param {string} objectType - E.g. Person
 * @param {object} selector - { firstName: "Henk" }
 * @returns {Promise} - for a string OR undefined if not found
 */
Connector.prototype.getId = function getId(objectType, selector) {
  return this.getIds(objectType, selector, { limit: 1 }).then(function (ids) {
    return ids.pop();
  });
};

/**
 *
 * @param objectType
 * @param selector - mongodb style
 * @param params
 * @returns {Promise} for objects
 */
Connector.prototype.search = function search(objectType, selector, params) {
  var _this6 = this;

  if (this.cache && !(params && params.fields)) {
    return this.getIds(objectType, selector, params).then(function (ids) {
      return _this6.getByIds(objectType, ids);
    });
  }

  if (selector && (typeof selector === 'undefined' ? 'undefined' : _typeof(selector)) === 'object' && Object.keys(selector).length) {
    return this._search(objectType, selector, params);
  }

  return this.getAll(objectType, params);
};

/**
 * This will save a document in Communibase. When a _id-field is found, this document will be updated
 *
 * @param objectType
 * @param object - the to-be-saved object data
 * @returns promise for object (the created or updated object)
 */
Connector.prototype.update = function update(objectType, object) {
  var deferred = defer();
  var operation = object._id && object._id.length > 0 ? 'PUT' : 'POST';

  if (object._id && this.cache && this.cache.objectCache && this.cache.objectCache[objectType] && this.cache.objectCache[objectType][object._id]) {
    this.cache.objectCache[objectType][object._id] = null;
  }

  this.queue.push({
    deferred: deferred,
    url: '' + this.serviceUrl + objectType + '.json/crud' + (operation === 'PUT' ? '/' + object._id : ''),
    options: {
      method: operation,
      body: JSON.stringify(object)
    }
  });

  return deferred.promise;
};

/**
 * Delete something from Communibase
 *
 * @param objectType
 * @param objectId
 * @returns promise (for null)
 */
Connector.prototype.destroy = function destroy(objectType, objectId) {
  var deferred = defer();

  if (this.cache && this.cache.objectCache && this.cache.objectCache[objectType] && this.cache.objectCache[objectType][objectId]) {
    this.cache.objectCache[objectType][objectId] = null;
  }

  this.queue.push({
    deferred: deferred,
    url: '' + this.serviceUrl + objectType + '.json/crud/' + objectId,
    options: {
      method: 'DELETE'
    }
  });

  return deferred.promise;
};

/**
 * Undelete something from Communibase
 *
 * @param objectType
 * @param objectId
 * @returns promise (for null)
 */
Connector.prototype.undelete = function (objectType, objectId) {
  var deferred = defer();

  this.queue.push({
    deferred: deferred,
    url: '' + this.serviceUrl + objectType + '.json/history/undelete/' + objectId,
    options: {
      method: 'POST'
    }
  });

  return deferred.promise;
};

/**
 * Get a Promise for a Read stream for a File stored in Communibase
 *
 * @param fileId
 * @returns {Stream} see http://nodejs.org/api/stream.html#stream_stream
 */
Connector.prototype.createReadStream = function (fileId) {
  var requestClient = https;
  var fileStream = stream.PassThrough();
  if (!this.serviceUrlIsHttps) {
    requestClient = http;
  }
  var req = requestClient.request(this.serviceUrl + 'File.json/binary/' + fileId + '?api_key=' + this.key, function (res) {
    if (res.statusCode === 200) {
      res.pipe(fileStream);
      return;
    }
    fileStream.emit('error', new Error(http.STATUS_CODES[res.statusCode]));
    fileStream.emit('end');
  });
  req.end();
  req.on('error', function (err) {
    fileStream.emit('error', err);
  });
  return fileStream;
};

/**
 * Get a new Communibase Connector, may be with a different API key
 *
 * @param apiKey
 * @returns {Connector}
 */
Connector.prototype.clone = function clone(apiKey) {
  return new Connector(apiKey);
};

/**
 * Get the history information for a certain type of object
 *
 * VersionInformation: {
 *    "_id": "ObjectId",
 *    "updatedAt": "Date",
 *    "updatedBy": "string"
 * }
 *
 * @param {string} objectType
 * @param {string} objectId
 * @returns promise for VersionInformation[]
 */
Connector.prototype.getHistory = function (objectType, objectId) {
  var deferred = defer();
  this.queue.push({
    deferred: deferred,
    url: '' + this.serviceUrl + objectType + '.json/history/' + objectId,
    options: {
      method: 'GET'
    }
  });
  return deferred.promise;
};

/**
 *
 * @param {string} objectType
 * @param {Object} selector
 * @returns promise for VersionInformation[]
 */
Connector.prototype.historySearch = function historySearch(objectType, selector) {
  var deferred = defer();
  this.queue.push({
    deferred: deferred,
    url: '' + this.serviceUrl + objectType + '.json/history/search',
    options: {
      method: 'POST',
      body: JSON.stringify(selector)
    }
  });
  return deferred.promise;
};

/**
 * Get a single object by a DocumentReference-object. A DocumentReference object looks like
 * {
 *  rootDocumentId: '524aca8947bd91000600000c',
 *  rootDocumentEntityType: 'Person',
 *  path: [
 * {
 *      field: 'addresses',
 *      objectId: '53440792463cda7161000003'
 *    }, ...
 *  ]
 * }
 *
 * @param {object} ref - DocumentReference style, see above
 * @param {object} parentDocument
 * @return {Promise} for referred object
 */
Connector.prototype.getByRef = function getByRef(ref, parentDocument) {
  if (!(ref && ref.rootDocumentEntityType && (ref.rootDocumentId || parentDocument))) {
    return Promise.reject(new Error('Please provide a documentReference object with a type and id'));
  }

  var rootDocumentEntityTypeParts = ref.rootDocumentEntityType.split('.');
  var parentDocumentPromise = void 0;
  if (rootDocumentEntityTypeParts[0] !== 'parent') {
    parentDocumentPromise = this.getById(ref.rootDocumentEntityType, ref.rootDocumentId);
  } else {
    parentDocumentPromise = Promise.resolve(parentDocument);
  }

  if (!(ref.path && ref.path.length && ref.path.length > 0)) {
    return parentDocumentPromise;
  }

  return parentDocumentPromise.then(function (result) {
    ref.path.some(function (pathNibble) {
      if (result[pathNibble.field]) {
        if (!result[pathNibble.field].some(function (subDocument) {
          if (subDocument._id === pathNibble.objectId) {
            result = subDocument;
            return true;
          }
          return false;
        })) {
          result = null;
          return true;
        }
        return false;
      }
      result = null;
      return true;
    });
    if (result) {
      return result;
    }
    throw new Error('The referred object within it\'s parent could not be found');
  });
};

/**
 *
 * @param {string} objectType - E.g. Event
 * @param {array} aggregationPipeline - E.g. A MongoDB-specific Aggregation Pipeline
 * @see http://docs.mongodb.org/manual/core/aggregation-pipeline/
 *
 * E.g. [
 * { "$match": { "_id": {"$ObjectId": "52f8fb85fae15e6d0806e7c7"} } },
 * { "$unwind": "$participants" },
 * { "$group": { "_id": "$_id", "participantCount": { "$sum": 1 } } }
 * ]
 */
Connector.prototype.aggregate = function aggregate(objectType, aggregationPipeline) {
  var _this7 = this;

  if (!aggregationPipeline || !aggregationPipeline.length) {
    return Promise.reject(new Error('Please provide a valid Aggregation Pipeline.'));
  }

  var hash = void 0;
  if (this.cache) {
    hash = JSON.stringify([objectType, aggregationPipeline]);
    if (!this.cache.aggregateCaches[objectType]) {
      this.cache.aggregateCaches[objectType] = LRU(1000); // 1000 getIds are this.cached, per entityType
    }
    var result = this.cache.aggregateCaches[objectType].get(hash);
    if (result) {
      return Promise.resolve(result);
    }
  }

  var deferred = defer();
  this.queue.push({
    deferred: deferred,
    url: '' + this.serviceUrl + objectType + '.json/aggregate',
    options: {
      method: 'POST',
      body: JSON.stringify(aggregationPipeline)
    }
  });

  var resultPromise = deferred.promise;

  if (this.cache) {
    return resultPromise.then(function (result) {
      _this7.cache.aggregateCaches[objectType].set(hash, result);
      return result;
    });
  }

  return resultPromise;
};

/**
 * Finalize an invoice by its ID
 *
 * @param invoiceId
 * @returns {*}
 */
Connector.prototype.finalizeInvoice = function finalizeInvoice(invoiceId) {
  var deferred = defer();
  this.queue.push({
    deferred: deferred,
    url: this.serviceUrl + 'Invoice.json/finalize/' + invoiceId,
    options: {
      method: 'POST'
    }
  });
  return deferred.promise;
};

/**
 * @param communibaseAdministrationId
 * @param socketServiceUrl
 */
Connector.prototype.enableCache = function enableCache(communibaseAdministrationId, socketServiceUrl) {
  var _this8 = this;

  this.cache = {
    getIdsCaches: {},
    aggregateCaches: {},
    dirtySock: io.connect(socketServiceUrl, { port: 443 }),
    objectCache: {},
    isAvailable: function isAvailable(objectType, objectId) {
      return _this8.cache.objectCache[objectType] && _this8.cache.objectCache[objectType][objectId];
    }
  };
  this.cache.dirtySock.on('connect', function () {
    _this8.cache.dirtySock.emit('join', communibaseAdministrationId + '_dirty');
  });
  this.cache.dirtySock.on('message', function (dirtyness) {
    var dirtyInfo = dirtyness.split('|');
    if (dirtyInfo.length !== 2) {
      console.log(new Date() + ': Got weird dirty sock data? ' + dirtyness);
      return;
    }
    _this8.cache.getIdsCaches[dirtyInfo[0]] = null;
    _this8.cache.aggregateCaches[dirtyInfo[0]] = null;
    if (dirtyInfo.length === 2 && _this8.cache.objectCache[dirtyInfo[0]]) {
      _this8.cache.objectCache[dirtyInfo[0]][dirtyInfo[1]] = null;
    }
  });
};

module.exports = new Connector(process.env.COMMUNIBASE_KEY);