/* Node-JS Google Play Music API
 *
 * Written by Jamon Terrell <git@jamonterrell.com>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Based partially on the work of the Google Play Music resolver for Tomahawk (https://github.com/tomahawk-player/tomahawk-resolvers/blob/master/gmusic/content/contents/code/gmusic.js)
 * and the gmusicapi project by Simon Weber (https://github.com/simon-weber/Unofficial-Google-Music-API/blob/develop/gmusicapi/protocol/mobileclient.py).
 */
var https = require('https');
var querystring = require('querystring');
var url = require('url');
var CryptoJS = require("crypto-js");
var uuid = require('node-uuid');
var util = require('util');
var crypto = require('crypto');

var pmUtil = {};
pmUtil.parseKeyValues = function(body) {
    var obj = {};
    body.split("\n").forEach(function(line) {
        var pos = line.indexOf("=");
        if(pos > 0) obj[line.substr(0, pos)] = line.substr(pos+1);
    });
    return obj;
};
pmUtil.Base64 = {
    _map: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
    stringify: CryptoJS.enc.Base64.stringify,
    parse: CryptoJS.enc.Base64.parse
};
pmUtil.salt = function(len) {
    return Array.apply(0, Array(len)).map(function() {
        return (function(charset){
            return charset.charAt(Math.floor(Math.random() * charset.length));
        }('abcdefghijklmnopqrstuvwxyz0123456789'));
    }).join('');
};

const BASE_URL = 'https://www.googleapis.com/sj/v1.11/';
const WEB_URL = 'https://play.google.com/music/';
const AUTH_URL = 'https://android.clients.google.com/auth';
const MOBILE_URL = 'https://android.clients.google.com/music/';

function request(token, options, parseResponse) {
  var opt = url.parse(options.url);
  opt.headers = Object.assign({}, options.headers, {
    "Content-type": options.contentType || "application/x-www-form-urlencoded"
  });
  if (token) {
    opt.headers.Authorization = "GoogleLogin auth=" + token
  }
  opt.method = options.method || "GET";

  return new Promise((resolve, reject) => {
    var req = https.request(opt, function(res) {
      res.setEncoding('utf8');
      var body = "";
      res.on('data', function(chunk) {
          body += chunk;
      });
      res.on('end', function() {
        if (res.statusCode >= 400) {
          var err = new Error(res.statusCode + " error from server: " + body);
          err.statusCode = res.statusCode;
          err.response = res;
          return reject(err);
        }

        return (parseResponse ? parseResponse : defaultParseResponse)(res, body).then(resolve, reject).catch(reject);
      });
      res.on('error', function(error) {
        var err = new Error("Error making https request");
        err.error = error;
        err.response = res;
        reject(err);
      });
    });

    if(typeof options.data !== "undefined") {
      req.write(options.data)
    }

    req.end();
  })
};

function defaultParseResponse(res, body) {
  return new Promise((resolve, reject) => {
    var contentType = null
    if (typeof res.headers["content-type"] === "string") {
      contentType = res.headers["content-type"].split(";", 1)[0].toLowerCase();
    }

    var response = body;
    try {
      if(contentType === "application/json") {
        response = JSON.parse(response);
      }
    } catch (e) {
      reject(new Error("unable to parse json response: " + e), res)
    }

    return resolve(response);
  });
}

function login(email, password) {
  // load signing key
  var s1 = CryptoJS.enc.Base64.parse('VzeC4H4h+T2f0VI180nVX8x+Mb5HiTtGnKgH52Otj8ZCGDz9jRWyHb6QXK0JskSiOgzQfwTY5xgLLSdUSreaLVMsVVWfxfa8Rw==');
  var s2 = CryptoJS.enc.Base64.parse('ZAPnhUkYwQ6y5DdQxWThbvhJHN8msQ1rqJw0ggKdufQjelrKuiGGJI30aswkgCWTDyHkTGK9ynlqTkJ5L4CiGGUabGeo8M6JTQ==');

  for(var idx = 0; idx < s1.words.length; idx++) {
      s1.words[idx] ^= s2.words[idx];
  }

  // todo: figure out better way to stringify key
  const key = JSON.stringify(s1);

  return oauth(email, password).then(
    (data) => {
      const token = data.Auth;

      return getSettings(token).then(response => {
        const settings = response.settings;
        const allAccess = response.settings.entitlementInfo.isSubscription;
        var devices = response.settings.uploadDevice.filter(function(d) {
          return d.deviceType === 2 || d.deviceType === 3;
        });

        var deviceId = null;
        if(devices.length > 0) {
          var id = devices[0].id;
          if (devices[0].deviceType === 2) {
              id = id.slice(2);
          }
          deviceId = id;
        }

        return {
          key: key,
          token: token,
          deviceId: deviceId,
          settings: settings,
          allAccess: allAccess
        }
      });
    },
    (err) => {
      throw err
    }
  );
};

function oauth(email, password) {
  if (!email || !password) {
    return Promise.reject(new Error("You must provide either an email address and password"));
  }

  var data = {
    Email: email.trim(),
    Passwd: password,
    accountType: "HOSTED_OR_GOOGLE",
    has_permission: 1,
    service: "sj",
    source: "android",
    androidId: null,
    app: "com.google.android.music",
    device_country: "us",
    operatorCountry: "us",
    //client_sig: "61ed377e85d386a8dfee6b864bd85b0bfaa5af81",
    lang: "en",
    sdk_version: "17"
  };

  return request(null, {
    method: "POST",
    url: AUTH_URL,
    contentType: "application/x-www-form-urlencoded",
    data: querystring.stringify(data)
  })
    .then(
      data => pmUtil.parseKeyValues(data),
      err => {
        throw new Error("Unable to create oauth token" + err)
      }
    )
};


/**
 * Returns settings / device ids authorized for account.
 *
 * @param callback function(err, settings) - success callback
 */
function getSettings(token) {
  // loadsettings returns text/plain even though it's json, so we have to manually parse it.
  function parseResponse(res, body) {
    var response;
    try {
      response = JSON.parse(body);
    } catch (e) {
      throw new Error("error parsing settings: " + e)
    }
    return Promise.resolve(response)
  }

  var options = {
    method: "POST",
    url: WEB_URL + "services/fetchsettings?" + querystring.stringify({u: 0}),
    contentType: "application/json",
    data: JSON.stringify({"sessionId": ""})
  }

  return request(token, options, parseResponse);
};

/**
 * Returns stream URL for a track.
 *
 * @param id string - track id, hyphenated is preferred, but "nid" will work for all access tracks (not uploaded ones)
 * @param callback function(err, streamUrl) - success callback
 */
function getStreamUrl(token, key, deviceId, id) {
  if(!deviceId) {
    return Promise.reject("Unable to find a usable device on your account, access from a mobile device and try again");
  }

  // todo: figure out better way to stringify key
  key = JSON.parse(key)

  var salt = pmUtil.salt(13);
  var sig = CryptoJS.HmacSHA1(id + salt, key).toString(pmUtil.Base64);
  var qp = {
    u: "0",
    net: "wifi",
    pt: "e",
    targetkbps: "8310",
    slt: salt,
    sig: sig
  };
  if(id.charAt(0) === "T") {
    qp.mjck = id;
  } else {
    qp.songid = id;
  }

  var qstring = querystring.stringify(qp);
  var options = {
    method: "GET",
    url: MOBILE_URL + 'mplay?' + qstring,
    headers: { "X-Device-ID": deviceId }
  }

  function parseResponse(res, body) {
    if (res.statusCode === 302 && typeof res.headers.location === "string") {
      return Promise.resolve(res.headers.location);
    }
    return Promise.reject('Unable to get stream url')
  }

  return request(token, options, parseResponse)
};

function getFavorites(token) {
  return request(token, {
    method: "POST",
    contentType: "application/json",
    url: WEB_URL + 'services/getephemthumbsup'
  }).then(
    (body) => {
      try {
        body = JSON.parse(body);
      } catch (err) {
        throw err;
      };
      return body.track;
    },
    (err) => {
      throw err
    }
  );
};

function search(token, query, maxResults) {
    var qp = {
        q: query,
        ct: '1,2,3,4,5,6,7,8,9',
        "max-results": maxResults || 20
    };
    var qstring = querystring.stringify(qp);
    return request(token, {
        method: "GET",
        url: BASE_URL + 'query?' + qstring
    }).then(
      (data) => data,
      (err) => {
        throw new Error("error getting search results: " + err)
      }
    );
};

module.exports = {
  login: login,
  getFavorites, getFavorites,
  getStreamUrl: getStreamUrl,
  search: search
}
