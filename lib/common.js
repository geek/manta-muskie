/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var EventEmitter = require('events').EventEmitter;
var http = require('http');
var os = require('os');
var path = require('path');
var util = require('util');
var httpSignature = require('http-signature');

var assert = require('assert-plus');
var libmanta = require('libmanta');
var vasync = require('vasync');
var restify = require('restify');

require('./errors');



///--- Globals

var sprintf = util.format;

var ANONYMOUS_USER = libmanta.ANONYMOUS_USER;

var CORS_RES_HDRS = [
    'access-control-allow-headers',
    'access-control-allow-origin',
    'access-control-expose-headers',
    'access-control-max-age',
    'access-control-allow-methods'
];

/* JSSTYLED */
var JOBS_PATH = /^\/([a-zA-Z][a-zA-Z0-9_\.@%]+)\/jobs\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/;
/* JSSTYLED */
var JOBS_ROOT_PATH = /^\/([a-zA-Z][a-zA-Z0-9_\.@%]+)\/jobs\/?.*/;
/* JSSTYLED */
var JOBS_STOR_PATH = /^\/([a-zA-Z][a-zA-Z0-9_\-\.@%]+)\/jobs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/stor/;
var PUBLIC_STOR_PATH = /^\/([a-zA-Z][a-zA-Z0-9_\-\.@%]+)\/public(\/(.*)|$)/;
var REPORTS_STOR_PATH = /^\/([a-zA-Z][a-zA-Z0-9_\-\.@%]+)\/reports(\/(.*)|$)/;
var STOR_PATH = /^\/([a-zA-Z][a-zA-Z0-9_\-\.@%]+)\/stor(\/(.*)|$)/;
/* JSSTYLED */
var MEDUSA_ROOT_PATH = /^\/([a-zA-Z][a-zA-Z0-9_\.@%]+)\/medusa\/?.*/;

// Thanks for being a PITA, javascriptlint (it doesn't like /../ form in [])
var ROOT_REGEXPS = [
    new RegExp('^\\/[a-zA-Z0-9_\\-\\.@%]+$'), // /:login
    new RegExp('^\\/[a-zA-Z0-9_\\-\\.@%]+\\/public\\/?$'), // public
    new RegExp('^\\/[a-zA-Z0-9_\\-\\.@%]+\\/stor\\/?$'), // storage
    new RegExp('^\\/[a-zA-Z0-9_\\-\\.@%]+\\/jobs\\/?$'), // jobs (list)

    // jobs storage
    new RegExp('^\\/[a-zA-Z0-9_\\-\\.@%]+\\/jobs\\/[\\w-]+\\/stor\\/?$'),
    new RegExp('^\\/[a-zA-Z0-9_\\-\\.@%]+\\/reports\\/?$') // reports
];

var PATH_LOGIN_RE = /^\/([a-zA-Z][a-zA-Z0-9_\-\.@%]+)\//;

var ZONENAME = os.hostname();



///--- Internals


///--- Patches

var HttpRequest = http.IncomingMessage.prototype; // save some chars

HttpRequest.abandonSharks = function abandonSharks() {
    var self = this;
    (this.sharks || []).forEach(function (shark) {
        shark.removeAllListeners('result');
        shark.abort();
        self.unpipe(shark);
    });
};


HttpRequest.isConditional = function isConditional() {
    return (this.headers['if-match'] !== undefined ||
            this.headers['if-none-match'] !== undefined);
};


HttpRequest.isMarlinRequest = function isMarlinRequest() {
    return (JOBS_ROOT_PATH.test(this.path()));
};

HttpRequest.isMedusaRequest = function isMedusaRequest() {
    return (MEDUSA_ROOT_PATH.test(this.path()));
};

HttpRequest.isPresigned = function isPresigned() {
    return (this._presigned);
};


HttpRequest.isPublicGet = function isPublicGet() {
    var ok = this.isReadOnly() && PUBLIC_STOR_PATH.test(this.path());

    return (ok);
};


HttpRequest.isPublicPut = function isPublicPut() {
    return (this.method === 'PUT' && PUBLIC_STOR_PATH.test(this.path()));
};


HttpRequest.isReadOnly = function isReadOnly() {
    var ro = this.method === 'GET' ||
        this.method === 'HEAD' ||
        this.method === 'OPTIONS';

    return (ro);
};


HttpRequest.isRootDirectory = function isRootDirectory(d) {
    function _test(dir) {
        var matches = ROOT_REGEXPS.some(function (re) {
            return (re.test(dir));
        });

        return (matches);
    }


    if (!d) {
        if (this._isRoot === undefined)
            this._isRoot = _test(this.path());

        return (this._isRoot);
    }

    return (_test(d));
};


HttpRequest.isRestrictedWrite = function isRestrictedWrite() {
    if (this.method !== 'PUT')
        return (false);

    var p = this.path();
    return (JOBS_PATH.test(p) || REPORTS_STOR_PATH.test(p));
};



///--- API

function createMetadata(req, type, cb) {
    var prev = req.metadata || {};
    // Override the UpdateMetadata type, as this flows in via PUT Object
    // path (ghetto...)
    if (prev.type === 'directory')
        type = 'directory';

    var names;
    var md = {
        dirname: path.dirname(req.key),
        key: req.key,
        headers: {},
        mtime: Date.now(),
        owner: req.owner.account.uuid,
        requestId: req.getId(),
        roles: [],
        type: type,
        // _etag is the moray etag, not the user etag
        // Note that we only specify the moray etag if the user sent
        // an etag on the request, otherwise, it's race time baby!
        // (on purpose) - note that the indexing ring will automatically
        // retry (once) on putMetadata if there was a Conflict Error and
        // no _etag was sent in
        _etag: req.isConditional() ? req.metadata._etag : undefined
    };

    CORS_RES_HDRS.forEach(function (k) {
        var h = req.header(k);
        if (h) {
            md.headers[k] = h;
        }
    });
    if (req.headers['cache-control'])
        md.headers['Cache-Control'] = req.headers['cache-control'];

    if (req.headers['surrogate-key'])
        md.headers['Surrogate-Key'] = req.headers['surrogate-key'];

    var hdrSize = 0;
    Object.keys(req.headers).forEach(function (k) {
        if (/^m-\w+/.test(k)) {
            hdrSize += Buffer.byteLength(req.headers[k]);
            if (hdrSize < (4 * 1024))
                md.headers[k] = req.headers[k];
        }
    });

    switch (type) {
    case 'directory':
        break;

    case 'link':
        md.link = req.link.metadata;
        break;

    case 'object':
        md.contentLength = req._size !== undefined ?
            req._size : prev.contentLength;
        md.contentMD5 = req._contentMD5 || prev.contentMD5;
        md.contentType = req.header('content-type') ||
            prev.contentType ||
            'application/octet-stream';
        md.objectId = req.objectId || prev.objectId;
        if (md.contentLength === 0) { // Chunked requests
            md.sharks = [];
        } else if (req.sharks && req.sharks.length) { // Normal requests
            md.sharks = req.sharks.map(function (s) {
                return ({
                    datacenter: s._shark.datacenter,
                    manta_storage_id: s._shark.manta_storage_id
                });
            });
        } else { // Take from the prev is for things like mchattr
            md.sharks = (prev.sharks || []);
        }
        break;

    default:
        break;
    }

    // mchattr
    var requestedRoleTags;
    if (req.auth && typeof (req.auth['role-tag']) === 'string') { // from URL
        requestedRoleTags = req.auth['role-tag'];
    } else {
        requestedRoleTags = req.headers['role-tag'];
    }

    if (requestedRoleTags) {
        /* JSSTYLED */
        names = requestedRoleTags.split(/\s*,\s*/);
        req.mahi.getUuid({
            account: req.owner.account.login,
            type: 'role',
            names: names
        }, function (err, lookup) {
            if (err) {
                cb(err);
                return;
            }
            var i;
            for (i = 0; i < names.length; i++) {
                if (!lookup.uuids[names[i]]) {
                    cb(new InvalidRoleTagError(names[i]));
                    return;
                }
                md.roles.push(lookup.uuids[names[i]]);
            }
            cb(null, md);
        });
    // apply all active roles if no other roles are specified
    } else if (req.caller.user) {
        md.roles = req.activeRoles;
        setImmediate(function () {
            cb(null, md);
        });
    } else {
        setImmediate(function () {
            cb(null, md);
        });
    }
}


function assertMetadata(req, res, next) {
    if (!req.metadata || !req.metadata.type) {
        next(new ResourceNotFoundError(req.getPath()));
    } else {
        next();
    }
}


function enforceSSL(req, res, next) {
    if (!req.isSecure() && !req.isPresigned() && !req.isPublicGet()) {
        next(new SSLRequiredError());
    } else {
        next();
    }
}


function ensureEntryExists(req, res, next) {
    if (!req.metadata || req.metadata.type === null) {
        next(new ResourceNotFoundError(req.path()));
    } else {
        next();
    }
}


function ensureNotDirectory(req, res, next) {
    // This is super ghetto, but we allow overwrites of directories
    // (which means we follow the object path) if the request is either
    // from a marlin proxy or it's only a metadata update.
    if (!req.metadata) {
        next(new DirectoryOperationError(req));
    } else if (req.metadata.type === 'directory') {
        if (req.metadata.marlinSpoof || req.query.metadata) {
            next();
        } else {
            next(new DirectoryOperationError(req));
        }
    } else {
        next();
    }
}


function ensureNotRoot(req, res, next) {
    if (!req.isRootDirectory()) {
        next();
        return;
    }

    if (req.method === 'PUT') {
        if (req.headers['content-type'] && req.headers['content-type'] !==
            'application/x-json-stream; type=directory') {
            next(new RootDirectoryError(req));
            return;
        }
    }

    if (req.method === 'DELETE' && !JOBS_PATH.test(req.path())) {
        next(new RootDirectoryError(req));
        return;
    }

    next();
}


function ensureParent(req, res, next) {
    req.log.debug({
        parentKey: req.parentKey,
        parentMetadata: req.parentMetadata
    }, 'ensureParent: entered');

    if (req.isRootDirectory() || req.isRootDirectory(req.parentKey)) {
        req.log.debug('ensureParent: done');
        next();
    } else if (!req.parentMetadata || req.parentMetadata.type === null) {
        next(new DirectoryDoesNotExistError(req));
    } else if (req.parentMetadata.type !== 'directory') {
        next(new ParentNotDirectoryError(req));
    } else {
        req.log.debug('ensureParent: done');
        next();
    }
}


function getMetadata(req, res, next) {
    var log = req.log;

    log.debug('getMetadata: entered');
    vasync.parallel({
        funcs: [
            function entryMD(cb) {
                var opts = {
                    key: req.key,
                    requestId: req.getId()
                };
                loadMetadata(req, opts, function (err, md, w) {
                    if (err) {
                        cb(err);
                    } else {
                        var obj = {
                            op: 'entry',
                            metadata: md,
                            etag: (w || {})._etag
                        };
                        cb(null, obj);
                    }
                });
            },
            // This is messy, but basically we don't resolve
            // the parent when we don't need to, but we want to
            // run in parallel when we do. So here we have some
            // funky logic to check when we don't.  It's some
            // sweet jack-hackery.
            function parentMD(cb) {
                if (req.method === 'GET' ||
                    req.method === 'HEAD' ||
                    req.method === 'DELETE' ||
                    req.isRootDirectory()) {
                    return (cb(null, {op: 'skip'}));
                }

                var opts = {
                    key: req.parentKey,
                    requestId: req.getId()
                };

                loadMetadata(req, opts, function (err, md, w) {
                    if (err) {
                        cb(err);
                    } else {
                        var p = req.parentKey;
                        if (req.isRootDirectory(p))
                            md.type = 'directory';
                        var obj = {
                            op: 'parent',
                            metadata: md,
                            etag: (w || {})._etag
                        };
                        cb(null, obj);
                    }
                });
                return (undefined);
            }
        ]
    }, function (err, results) {
        if (err)
            return (next(err));

        results.successes.forEach(function (r) {
            switch (r.op) {
            case 'entry':
                req.metadata = r.metadata;
                req.metadata._etag = r.etag || null;
                req.metadata.headers =
                    req.metadata.headers || {};
                if (r.metadata.etag)
                    res.set('Etag', r.metadata.etag);
                if (r.metadata.mtime) {
                    var d = new Date(r.metadata.mtime);
                    res.set('Last-Modified', d);
                }
                break;

            case 'parent':
                req.parentMetadata = r.metadata;
                break;

            default:
                break;
            }
        });

        log.debug({
            metadata: req.metadata,
            parentMetadata: req.parentMetadata
        }, 'getMetadata: done');
        return (next());
    });
}


function loadMetadata(req, opts, callback) {
    req.moray.getMetadata(opts, function (err, md, wrap) {
        if (err) {
            if (err.name === 'ObjectNotFoundError') {
                md = {
                    type: (req.isRootDirectory() ?
                           'directory' :
                           null)
                };
            } else {
                return (callback(err, req));
            }
        } else {
            /*
             * We want to save which shard the metadata was fetched from for
             * logging purposes, but `wrap` will only contain this information
             * if there wasn't an error, whether fatal or not.
             */
            req.shard = wrap._node.pnode;
        }

        if (md.roles) {
            md.headers = md.headers || {};
            req.mahi.getName({
                uuids: md.roles
            }, function (err2, lookup) {
                if (err2) {
                    return (callback(err2));
                }
                if (md.roles && md.roles.length) {
                    md.headers['role-tag'] = md.roles.filter(function (uuid) {
                        return (lookup[uuid]);
                    }).map(function (uuid) {
                        return (lookup[uuid]);
                    }).join(', ');
                }
                return (callback(null, md, wrap));
            });
        } else {
            return (callback(null, md, wrap));
        }
    });
}


function addCustomHeaders(req, res) {
    var md = req.metadata.headers;
    var origin = req.headers.origin;

    Object.keys(md).forEach(function (k) {
        var add = false;
        var val = md[k];
        // See http://www.w3.org/TR/cors/#resource-requests
        if (origin && CORS_RES_HDRS.indexOf(k) !== -1) {
            if (k === 'access-control-allow-origin') {
                /* JSSTYLED */
                if (val.split(/\s*,\s*/).some(function (v) {
                    if (v === origin || v === '*') {
                        val = origin;
                        return (true);
                    }
                    return (false);
                })) {
                    add = true;
                } else {
                    CORS_RES_HDRS.forEach(function (h) {
                        res.removeHeader(h);
                    });
                }
            } else if (k === 'access-control-allow-methods') {
                /* JSSTYLED */
                if (val.split(/\s*,\s*/).some(function (v) {
                    return (v === req.method);
                })) {
                    add = true;
                } else {
                    CORS_RES_HDRS.forEach(function (h) {
                        res.removeHeader(h);
                    });
                }
            } else if (k === 'access-control-expose-headers') {
                add = true;
            }
        } else {
            add = true;
        }

        if (add)
            res.header(k, val);
    });
}


function readdir(dir, req) {
    var l = parseInt(req.params.limit || 256, 10);
    if (l <= 0 || l > 1024) {
        var ee = new EventEmitter();
        process.nextTick(function () {
            ee.emit('error', new InvalidLimitError(l));
        });
        return (ee);
    }

    var account = req.owner.account.uuid;
    // We want the really low-level API here, as we want to go hit the place
    // where all the keys are, not where the dirent itself is.
    var client = req.moray;
    var filter = '(&';

    //The 'dir' above comes in as the path of the request.  The 'dir'
    // and 'obj' parameters are filters.
    var hasDir = (req.params.dir !== undefined ||
                  req.params.directory !== undefined);
    var hasObj = (req.params.obj !== undefined ||
                  req.params.object !== undefined);

    if ((hasDir && hasObj) || !(hasDir || hasObj)) {
        filter += sprintf('(owner=%s)(dirname=%s)', account, dir);
    } else if (hasDir) {
        filter += sprintf('(owner=%s)(dirname=%s)(type=directory)',
                          account, dir);
    } else {
        filter += sprintf('(owner=%s)(dirname=%s)(type=object)',
                          account, dir);
    }

    var marker = req.params.marker;
    var reverse = req.params.sort_order === 'reverse';
    var tsort = req.params.sort === 'mtime';

    if (marker) {
        if (tsort) {
            marker = new Date(marker).getTime();
            if (!marker) {
                ee = new EventEmitter();
                setImmediate(function () {
                    ee.emit('error',
                            new InvalidParameterError('marker',
                                                      req.params.marker));
                });
                return (ee);
            }

            if (reverse) {
                filter += sprintf('(_mtime>=%s)', marker);
            } else {
                filter += sprintf('(_mtime<=%s)', marker);
            }
        } else {
            if (reverse) {
                filter += sprintf('(name<=%s)', marker);
            } else {
                filter += sprintf('(name>=%s)', marker);
            }
        }
    }
    filter += ')';


    var log = req.log;
    var opts = {
        filter: filter,
        limit: l,
        requestId: req.getId(),
        sort: {},
        hashkey: dir,
        no_count: true
    };

    if (tsort) {
        opts.sort.attribute = '_mtime';
        if (reverse) {
            opts.sort.order = 'ASC';
        } else {
            opts.sort.order = 'DESC';
        }
    } else {
        opts.sort.attribute = 'name';
        if (reverse) {
            opts.sort.order = 'DESC';
        } else {
            opts.sort.order = 'ASC';
        }
    }

    log.debug({
        dir: dir,
        filter: filter
    }, 'readdir: entered');
    var mreq = client.search(opts);

    mreq.on('record', function (r) {
        if (r.key !== req.key) {
            var entry = {
                name: r.key.split('/').pop(),
                etag: r.value.etag,
                size: r.value.contentLength,
                type: r.value.type,
                mtime: new Date(r.value.mtime).toISOString()
            };

            if (entry.type === 'object')
                entry.durability = (r.value.sharks || []).length || 0;

            mreq.emit('entry', entry, r);
        }
    });

    return (mreq);
}



///--- Exports

module.exports = {

    ANONYMOUS_USER: ANONYMOUS_USER,

    JOBS_PATH: JOBS_PATH,

    STOR_PATH: STOR_PATH,

    JOBS_STOR_PATH: JOBS_STOR_PATH,

    PUBLIC_STOR_PATH: PUBLIC_STOR_PATH,

    REPORTS_STOR_PATH: REPORTS_STOR_PATH,

    PATH_LOGIN_RE: PATH_LOGIN_RE,

    StoragePaths: {
        'public': {
            'name': 'Public',
            'regex': PUBLIC_STOR_PATH
        },
        'stor': {
            'name': 'Storage',
            'regex': STOR_PATH
        },
        'jobs': {
            'name': 'Jobs',
            'regex': JOBS_ROOT_PATH
        },
        'reports': {
            'name': 'Reports',
            'regex': REPORTS_STOR_PATH
        }
    },

    createMetadata: createMetadata,

    loadMetadata: loadMetadata,

    readdir: readdir,

    addCustomHeaders: addCustomHeaders,

    earlySetupHandler: function (opts) {
        assert.object(opts, 'options');

        function earlySetup(req, res, next) {
            res.once('header', function onHeader() {
                var now = Date.now();
                res.header('Date', new Date());
                res.header('Server', 'Manta');
                res.header('x-request-id', req.getId());

                var xrt = res.getHeader('x-response-time');
                if (xrt === undefined) {
                    var t = now - req.time();
                    res.header('x-response-time', t);
                }
                res.header('x-server-name', ZONENAME);
            });

            // Make req.isSecure() work as expected
            // We simply ensure that the request came in on the
            // standard port that is fronted by muppet, not the one
            // dedicated for cleartext connections
            var p = req.connection.address().port;
            req._secure = (p === opts.port);

            // This will only be null on the _first_ request, and in
            // that instance, we're guaranteed that HAProxy sent us
            // an X-Forwarded-For header
            if (!req.connection._xff) {
                // Clean up clientip if IPv6
                var xff = req.headers['x-forwarded-for'];
                if (xff) {
                    /* JSSTYLED */
                    xff = xff.split(/\s*,\s*/).pop() || '';
                    xff = xff.replace(/^(f|:)+/, '');
                    req.connection._xff = xff;
                } else {
                    req.connection._xff =
                        req.connection.remoteAddress;
                }
            }

            var ua = req.headers['user-agent'];
            if (ua && /^curl.+/.test(ua))
                res.set('Connection', 'close');

            next();
        }

        return (earlySetup);
    },

    authorizationParser: function (req, res, next) {
        req.authorization = {};

        if (!req.headers.authorization)
            return (next());

        var pieces = req.headers.authorization.split(' ', 2);
        if (!pieces || pieces.length !== 2) {
            var e = new restify.InvalidHeaderError(
                'Invalid Authorization header');
            return (next(e));
        }

        req.authorization.scheme = pieces[0];
        req.authorization.credentials = pieces[1];

        if (pieces[0].toLowerCase() === 'signature') {
            try {
                req.authorization.signature = httpSignature.parseRequest(req);
            } catch (e2) {
                var err = new restify.InvalidHeaderError('Invalid Signature ' +
                    'Authorization header: ' + e2.message);
                throw (err);
            }
        }

        next();
    },

    assertMetadataHandler: function () {
        return (assertMetadata);
    },

    enforceSSLHandler: function () {
        return (enforceSSL);
    },

    ensureEntryExistsHandler: function () {
        return (ensureEntryExists);
    },

    ensureNotDirectoryHandler: function () {
        return (ensureNotDirectory);
    },

    ensureNotRootHandler: function () {
        return (ensureNotRoot);
    },

    ensureParentHandler: function () {
        return (ensureParent);
    },

    getMetadataHandler: function () {
        return (getMetadata);
    },

    setupHandler: function (options) {
        assert.object(options, 'options');
        assert.object(options.jobCache, 'options.jobCache');
        assert.object(options.log, 'options.log');
        assert.func(options.keyapi, 'options.keyapi');
        assert.func(options.mahi, 'options.mahi');
        assert.func(options.marlin, 'options.marlin');
        assert.func(options.picker, 'options.picker');
        assert.func(options.moray, 'options.moray');
        assert.func(options.medusa, 'options.medusa');
        assert.object(options.sharkConfig, 'options.sharkConfig');

        function setup(req, res, next) {
            req.config = options;
            req.moray = options.moray();

            // MANTA-331: while a trailing '/' is ok in HTTP,
            // this messes with the consistent hashing, so
            // ensure there isn't one
            /* JSSTYLED */
            req._path = req._path.replace(/\/*$/, '');

            req.jobCache = options.jobCache;

            req.log = (req.log || options.log).child({
                method: req.method,
                path: req.path(),
                req_id: req.getId()
            }, true);

            req.mahi = options.mahi();
            req.marlin = options.marlin();
            req.keyapi = options.keyapi();
            req.picker = options.picker();
            req.sharks = [];
            req.sharkConfig = options.sharkConfig;
            req.medusa = options.medusa();

            var _opts = {
                account: req.owner.account,
                path: req.path()
            };
            libmanta.normalizeMantaPath(_opts, function (err, p) {
                if (err) {
                    req.log.debug({
                        url: req.path(),
                        err: err
                    }, 'failed to normalize URL');
                    next(new InvalidPathError(req.path()));
                } else {
                    req.key = p;
                    if (!req.isRootDirectory()) {
                        req.parentKey =
                            path.dirname(req.key);
                    }

                    req.log.debug({
                        params: req.params,
                        path: req.path()
                    }, 'setup complete');
                    next();
                }
            });
        }

        return (setup);
    },

    // Not used anymore
    debugRequestHandler: function () {
        function _debugLogRequest(req, res, next) {
            var log = req.log;
            var str = req.method + ' ' +
                req.url + ' ' +
                req.httpVersion + '\n';
            Object.keys(req.headers).sort().forEach(function (k) {
                str += k + ': ' + req.headers[k] + '\n';
            });
            log.debug('handling request:\n%s\n', str);
            return (next());
        }

        return (_debugLogRequest);
    }

};
