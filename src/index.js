const fetch = require('isomorphic-fetch');
const async = require('async');
const http = require('http');
const https = require('https');
const stream = require('stream');
const io = require('socket.io-client');
const LRU = require('lru-cache');
const Promise = require('bluebird');

function defer() {
  let deferResolve;
  let deferReject;
  const promise = new Promise((resolve, reject) => {
    deferResolve = resolve;
    deferReject = reject;
  });
  return {
    resolve: deferResolve,
    reject: deferReject,
    promise
  };
}

function CommunibaseError(data) {
  this.name = 'CommunibaseError';
  this.code = (data.code || 500);
  this.message = (data.message || '');
  this.errors = (data.errors || {});

  Error.captureStackTrace(this, CommunibaseError);
}

CommunibaseError.prototype = Error.prototype;
/**
 * Constructor for connector.
 *
 * @param key - The communibase api key
 * @constructor
 */
const Connector = function (key) {
  this.getByIdQueue = {};
  this.getByIdPrimed = false;
  this.key = key;
  this.token = '';
  this.setServiceUrl(process.env.COMMUNIBASE_API_URL || 'https://api.communibase.nl/0.1/');
  this.queue = async.queue((task, callback) => {
    function fail(errorish) {
      let error = errorish;
      if (!(error instanceof Error)) {
        error = new CommunibaseError(error, task);
      }
      task.deferred.reject(error);
      callback();
      return null;
    }

    if (!this.key && !this.token) {
      fail(new Error('Missing key or token for Communibase Connector: please set COMMUNIBASE_KEY environment' +
        ' variable, or spawn a new instance using require(\'communibase-connector-js\').clone(\'<' +
        'your api key>\')'));
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

    if (this.key) {
      task.options.headers['x-api-key'] = this.key;
    }
    if (this.token) {
      task.options.headers['x-access-token'] = this.token;
    }
    // not support by fetch spec / whatwg-fetch
    if (task.options.query) {
      task.url += `?${Object.keys(task.options.query).map(
        queryVar => (`${encodeURIComponent(queryVar)}=${encodeURIComponent(task.options.query[queryVar])}`)
      ).join('&')}`;
      task.options.query = undefined;
    }

    let success = false;
    return Promise.resolve(fetch(task.url, task.options)).then((response) => {
      success = (response.status === 200);
      return response.json();
    }).then((result) => {
      if (success) {
        const deferred = task.deferred;
        let records = result;
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
  this.serviceUrlIsHttps = (newServiceUrl.indexOf('https') === 0);
};

/**
 *
 * Bare boned search
 * @returns {Promise}
 *
 */
Connector.prototype._search = function (objectType, selector, params) {
  const deferred = defer();
  this.queue.push({
    deferred,
    url: `${this.serviceUrl}${objectType}.json/search`,
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
  Object.keys(this.getByIdQueue).forEach((objectType) => {
    const deferredsById = this.getByIdQueue[objectType];
    const objectIds = Object.keys(deferredsById);

    this.getByIdQueue[objectType] = {};
    this._getByIds(objectType, objectIds).then((objects) => {
      const objectHash = objects.reduce((previousValue, object) => {
        previousValue[object._id] = object;
        return previousValue;
      }, {});
      objectIds.forEach((objectId) => {
        if (objectHash[objectId]) {
          deferredsById[objectId].resolve(objectHash[objectId]);
          return;
        }
        deferredsById[objectId].reject(new Error(`${objectId} is not found`));
      });
    },
    (err) => {
      objectIds.forEach((objectId) => {
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
  if (typeof objectId !== 'string' || objectId.length !== 24) {
    return Promise.reject(new Error('Invalid objectId'));
  }

  // not combinable...
  if (versionId || (params && params.fields)) {
    const deferred = defer();
    this.queue.push({
      deferred,
      url: `${this.serviceUrl}${objectType}.json/${(versionId ?
          `history/${objectId}/${versionId}` :
          `crud/${objectId}`)}`,
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
    process.nextTick(() => {
      this.spoolQueue();
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
  if (objectIds.length === 0) {
    return Promise.resolve([]);
  }

  // not combinable...
  if (params && params.fields) {
    return this._getByIds(objectType, objectIds, params);
  }

  return Promise.all(
    objectIds.map(objectId => this.getById(objectType, objectId, params).reflect())
  ).then((inspections) => {
    const result = [];
    let error = null;
    inspections.forEach((inspection) => {
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

  const deferred = defer();
  this.queue.push({
    deferred,
    url: `${this.serviceUrl}${objectType}.json/crud`,
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
  let hash;
  if (this.cache) {
    hash = JSON.stringify([objectType, selector, params]);
    if (!this.cache.getIdsCaches[objectType]) {
      this.cache.getIdsCaches[objectType] = LRU(1000); // 1000 getIds are this.cached, per entityType
    }
    const result = this.cache.getIdsCaches[objectType].get(hash);
    if (result) {
      return Promise.resolve(result);
    }
  }

  const resultPromise = this.search(objectType, selector, Object.assign({ fields: '_id' }, params))
    .then(results => results.map(result => result._id));

  if (this.cache) {
    resultPromise.then((ids) => {
      this.cache.getIdsCaches[objectType].set(hash, ids);
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
  return this.getIds(objectType, selector, { limit: 1 }).then(ids => ids.pop());
};

/**
 *
 * @param objectType
 * @param selector - mongodb style
 * @param params
 * @returns {Promise} for objects
 */
Connector.prototype.search = function search(objectType, selector, params) {
  if (this.cache && !(params && params.fields)) {
    return this.getIds(objectType, selector, params).then(ids => this.getByIds(objectType, ids));
  }

  if (selector && (typeof selector === 'object') && Object.keys(selector).length) {
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
  const deferred = defer();
  const operation = ((object._id && (object._id.length > 0)) ? 'PUT' : 'POST');

  if (object._id && this.cache && this.cache.objectCache && this.cache.objectCache[objectType] &&
      this.cache.objectCache[objectType][object._id]) {
    this.cache.objectCache[objectType][object._id] = null;
  }

  this.queue.push({
    deferred,
    url: `${this.serviceUrl}${objectType}.json/crud${((operation === 'PUT') ? `/${object._id}` : '')}`,
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
  const deferred = defer();

  if (this.cache && this.cache.objectCache && this.cache.objectCache[objectType] &&
      this.cache.objectCache[objectType][objectId]) {
    this.cache.objectCache[objectType][objectId] = null;
  }

  this.queue.push({
    deferred,
    url: `${this.serviceUrl}${objectType}.json/crud/${objectId}`,
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
  const deferred = defer();

  this.queue.push({
    deferred,
    url: `${this.serviceUrl}${objectType}.json/history/undelete/${objectId}`,
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
  let requestClient = https;
  const fileStream = stream.PassThrough();
  if (!this.serviceUrlIsHttps) {
    requestClient = http;
  }
  const req = requestClient.request(
    `${this.serviceUrl}File.json/binary/${fileId}?api_key=${this.key}`,
    (res) => {
      if (res.statusCode === 200) {
        res.pipe(fileStream);
        return;
      }
      fileStream.emit('error', new Error(http.STATUS_CODES[res.statusCode]));
      fileStream.emit('end');
    }
  );
  req.end();
  req.on('error', (err) => {
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
  const deferred = defer();
  this.queue.push({
    deferred,
    url: `${this.serviceUrl}${objectType}.json/history/${objectId}`,
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
  const deferred = defer();
  this.queue.push({
    deferred,
    url: `${this.serviceUrl}${objectType}.json/history/search`,
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

  const rootDocumentEntityTypeParts = ref.rootDocumentEntityType.split('.');
  let parentDocumentPromise;
  if (rootDocumentEntityTypeParts[0] !== 'parent') {
    parentDocumentPromise = this.getById(ref.rootDocumentEntityType, ref.rootDocumentId);
  } else {
    parentDocumentPromise = Promise.resolve(parentDocument);
  }

  if (!(ref.path && ref.path.length && ref.path.length > 0)) {
    return parentDocumentPromise;
  }

  return parentDocumentPromise.then((result) => {
    ref.path.some((pathNibble) => {
      if (result[pathNibble.field]) {
        if (!result[pathNibble.field].some((subDocument) => {
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
  if (!aggregationPipeline || !aggregationPipeline.length) {
    return Promise.reject(new Error('Please provide a valid Aggregation Pipeline.'));
  }

  let hash;
  if (this.cache) {
    hash = JSON.stringify([objectType, aggregationPipeline]);
    if (!this.cache.aggregateCaches[objectType]) {
      this.cache.aggregateCaches[objectType] = LRU(1000); // 1000 getIds are this.cached, per entityType
    }
    const result = this.cache.aggregateCaches[objectType].get(hash);
    if (result) {
      return Promise.resolve(result);
    }
  }

  const deferred = defer();
  this.queue.push({
    deferred,
    url: `${this.serviceUrl}${objectType}.json/aggregate`,
    options: {
      method: 'POST',
      body: JSON.stringify(aggregationPipeline)
    }
  });

  const resultPromise = deferred.promise;

  if (this.cache) {
    return resultPromise.then((result) => {
      this.cache.aggregateCaches[objectType].set(hash, result);
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
  const deferred = defer();
  this.queue.push({
    deferred,
    url: `${this.serviceUrl}Invoice.json/finalize/${invoiceId}`,
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
  this.cache = {
    getIdsCaches: {},
    aggregateCaches: {},
    dirtySock: io.connect(socketServiceUrl, { port: 443 }),
    objectCache: {},
    isAvailable: (objectType, objectId) => (this.cache.objectCache[objectType]
        && this.cache.objectCache[objectType][objectId])
  };
  this.cache.dirtySock.on('connect', () => {
    this.cache.dirtySock.emit('join', `${communibaseAdministrationId}_dirty`);
  });
  this.cache.dirtySock.on('message', (dirtyness) => {
    const dirtyInfo = dirtyness.split('|');
    if (dirtyInfo.length !== 2) {
      console.log(`${new Date()}: Got weird dirty sock data? ${dirtyness}`);
      return;
    }
    this.cache.getIdsCaches[dirtyInfo[0]] = null;
    this.cache.aggregateCaches[dirtyInfo[0]] = null;
    if ((dirtyInfo.length === 2) && this.cache.objectCache[dirtyInfo[0]]) {
      this.cache.objectCache[dirtyInfo[0]][dirtyInfo[1]] = null;
    }
  });
};

module.exports = new Connector(process.env.COMMUNIBASE_KEY);