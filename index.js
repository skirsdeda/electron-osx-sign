'use strict'

var fs = require('fs')
var path = require('path')
var child = require('child_process')
var Promise = require('bluebird')
var debug = require('debug')
var debuglog = debug('electron-osx-sign')
debuglog.log = console.log.bind(console)
var debugwarn = debug('electron-osx-sign:warn')
debugwarn.log = console.warn.bind(console)
var debugerror = debug('electron-osx-sign:error')
debugerror.log = console.error.bind(console)
var isBinaryFileAsync = Promise.promisify(require('isbinaryfile'))
var execFileAsync = Promise.promisify(child.execFile)
var statAsync = Promise.promisify(fs.stat)

/**
 * This function returns a promise with platform resolved.
 * @param {Object} opts - Options.
 * @returns {Promise} Promise resolving platform.
 */
function detectElectronPlatformAsync (opts) {
  return new Promise(function (resolve) {
    var appFrameworksPath = getAppFrameworksPath(opts)
    // The presence of Squirrel.framework identifies a Mac App Store build as used in https://github.com/atom/electron/blob/master/docs/tutorial/mac-app-store-submission-guide.md
    return statAsync(path.join(appFrameworksPath, 'Squirrel.framework'))
      .then(function () {
        resolve('darwin')
      })
      .catch(function () {
        resolve('mas')
      })
  })
}

/**
 * This function returns a promise checking the indentity proposed and updates the identity option to a exact finding from results.
 * @param {Object} opts - Options.
 * @param {string} identity - The proposed identity.
 * @returns {Promise} Promise.
 */
function findIdentityAsync (opts, identity) {
  return new Promise(function (resolve, reject) {
    // Only to look for valid identities, excluding those flagged with
    // CSSMERR_TP_CERT_EXPIRED or CSSMERR_TP_NOT_TRUSTED. Fixes #9

    var args = [
      'find-identity',
      '-v',
      '-p',
      'codesigning'
    ]
    if (opts.keychain) {
      args.push(opts.keychain)
    }

    execFileAsync('security', args)
      .then(function (result) {
        var lines = result.split('\n')
        var location
        for (var i = 0, l = lines.length; i < l; i++) {
          var line = lines[i]
          location = line.indexOf(identity)
          if (location >= 0) {
            opts.identity = line.substring(line.indexOf('"') + 1, line.lastIndexOf('"'))
            break
          }
        }
        if (!opts.identity) reject('No identity found for signing.')
        else resolve(null)
      })
      .catch(function (err) {
        debugerror(err)
        reject('Error in finding identity. See details in debug log (electron-osx-sign:error).')
      })
  })
}

/**
 * This function returns a promise flattening the application.
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
function flatApplicationAsync (opts) {
  var args = [
    '--component', opts.app, opts.install,
    '--sign', opts.identity,
    opts.pkg
  ]
  if (opts.keychain) {
    args.unshift('--keychain', opts.keychain)
  }

  debuglog('Flattening... ' + opts.app)
  return execFileAsync('productbuild', args)
    .thenReturn(null)
}

/**
 * This function returns the path to app contents.
 * @param {Object} opts - Options.
 * @returns {string} App contents path.
 */
function getAppContentsPath (opts) {
  return path.join(opts.app, 'Contents')
}

/**
 * This function returns the path to app frameworks within contents.
 * @param {Object} opts - Options.
 * @returns {string} App frameworks path.
 */
function getAppFrameworksPath (opts) {
  return path.join(getAppContentsPath(opts), 'Frameworks')
}

/**
 * This function returns a promise resolving the file path if file binary.
 * @param {string} filePath - Path to file.
 * @returns {Promise} Promise resolving file path or null.
 */
function getFilePathIfBinaryAsync (filePath) {
  return isBinaryFileAsync(filePath)
    .then(function (isBinary) {
      return isBinary ? filePath : null
    })
}

/**
 * This function returns a promise validating opts.app, the application to be signed or flattened
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
function validateOptsApplicationAsync (opts) {
  return new Promise(function (resolve, reject) {
    if (!opts.app) reject('Path to aplication must be specified.')
    if (path.extname(opts.app) !== '.app') reject('Extension of application must be `.app`.')
    return statAsync(opts.app)
      .then(function () {
        resolve(null)
      })
      .catch(function (err) {
        debugerror(err)
        reject('Application not found. See details in debug log (electron-osx-sign:error).')
      })
  })
}

/**
 * This function returns a promise validating opts.binaries, the additional binaries to be signed along with the discovered enclosed components.
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
function validateOptsBinariesAsync (opts) {
  return new Promise(function (resolve, reject) {
    if (opts.binaries) {
      if (!Array.isArray(opts.binaries)) reject('Additional binaries should be an Array.')
      // TODO: Loop check every binary file for existence, reject promise if any not found
    }
    resolve(null)
  })
}

/**
 * This function returns a promise validating opts.platform, the platform of Electron build. It allows auto-discovery if no opts.platform is specified.
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
function validateOptsPlatformAsync (opts) {
  return new Promise(function (resolve) {
    if (opts.platform) {
      if (opts.platform === 'mas' || opts.platform === 'darwin') {
        resolve(null)
      }
    }
    debugwarn('No `platform` passed in arguments, checking Electron platform...')
    return detectElectronPlatformAsync(opts)
      .then(function (platform) {
        opts.platform = platform
        resolve(null)
      })
  })
}

/**
 * This function returns a promise resolving all child paths within the directory specified.
 * @param {string} dirPath - Path to directory.
 * @returns {Promise} Promise resolving child paths needing signing in order.
 */
function walkAsync (dirPath) {
  var unlinkAsync = Promise.promisify(fs.unlink)
  var readdirAsync = Promise.promisify(fs.readdir)

  function _walkAsync (dirPath) {
    return readdirAsync(dirPath)
      .then(function (names) {
        return Promise.map(names, function (name) {
          var filePath = path.join(dirPath, name)
          return statAsync(filePath)
            .then(function (stat) {
              if (stat.isFile()) {
                switch (path.extname(filePath)) {
                  case '': // Binary
                    if (path.basename(filePath)[0] !== '.') {
                      return getFilePathIfBinaryAsync(filePath)
                    } // Else reject hidden file
                    break
                  case '.dylib': // Dynamic library
                  case '.node': // Native node addon
                    return filePath
                  case '.cstemp': // Temporary file generated from past codesign
                    debuglog('Removing... ' + filePath)
                    return unlinkAsync(filePath)
                      .thenReturn(null)
                  default:
                    if (path.extname(filePath).indexOf(' ') > -1) {
                      // Still consider the file as binary if extension seems invalid
                      return getFilePathIfBinaryAsync(filePath)
                    }
                }
              } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
                return _walkAsync(filePath)
                  .then(function (result) {
                    switch (path.extname(filePath)) {
                      case '.app': // Application
                      case '.framework': // Framework
                        result.push(filePath)
                    }
                    return result
                  })
              }
              return null
            })
        })
      })
  }

  return _walkAsync(dirPath)
    .then(function (result) {
      function populateChildPaths (list) {
        if (!Array.isArray(list)) {
          childPaths.push(list)
        } else if (list.length > 0) {
          for (let item of list) {
            if (item != null) {
              populateChildPaths(item)
            }
          }
        }
      }

      var childPaths = []
      populateChildPaths(result)
      return childPaths
    })
}

/**
 * This function returns a promise codesigning only.
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
function signApplicationAsync (opts) {
  return walkAsync(getAppContentsPath(opts))
    .then(function (childPaths) {
      if (opts.binaries) childPaths = childPaths.concat(opts.binaries)

      var args = [
        '--sign', opts.identity,
        '-fv'
      ]
      if (opts.keychain) {
        args.push('--keychain', opts.keychain)
      }

      var promise
      if (opts.entitlements) {
        // Sign with entitlements
        promise = Promise.mapSeries(childPaths, function (filePath) {
          debuglog('Signing... ' + filePath)
          return execFileAsync('codesign', args.concat('--entitlements', opts['entitlements-inherit'], filePath))
        })
          .then(function () {
            debuglog('Signing... ' + opts.app)
            execFileAsync('codesign', args.concat('--entitlements', opts.entitlements, opts.app))
          })
      } else {
        // Otherwise normally
        promise = Promise.mapSeries(childPaths, function (filePath) {
          debuglog('Signing... ' + filePath)
          return execFileAsync('codesign', args.concat(filePath))
        })
          .then(function () {
            debuglog('Signing... ' + opts.app)
            return execFileAsync('codesign', args.concat(opts.app))
          })
      }

      // Lastly verify codesign
      return promise
        .then(function () {
          debuglog('Verifying sign...')
          var promise = execFileAsync('codesign', ['-v', opts.app])
          if (opts.entitlements) {
            // Check entitlements
            promise
              .then(function () {
                debuglog('Verifying entitlements...')
                return Promise.all([promise, execFileAsync('codesign', ['-d', '--entitlements', '-', opts.app])])
              })
          } else {
            return promise
          }
        })
    })
    .thenReturn(null)
}

/**
 * This function is exported and returns a promise signing the application.
 * @param {mixed} opts - Options.
 * @returns {Promise} Promise.
 */
function signAsync (opts) {
  if (opts.ignore) {
    if (typeof opts.ignore !== 'function' || typeof opts.ignore !== 'string') return Promise.reject('Ignore filter should be either a function or a string.')
  }

  return validateOptsApplicationAsync(opts)
    .then(function () {
      return validateOptsPlatformAsync(opts)
    })
    .then(function () {
      if (opts.platform === 'mas') {
        // To sign apps for Mac App Store, an entitlements file is required, especially for app sandboxing (as well some other services).
        // Fallback entitlements for sandboxing by default: Note this may cause troubles while running an signed app due to missing keys special to the project.
        // Further reading: https://developer.apple.com/library/mac/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html
        if (!opts.entitlements) {
          debugwarn('No `entitlements` passed in arguments, will fallback to default settings.')
          opts.entitlements = path.join(__dirname, 'default.mas.entitlements')
        }
        if (!opts['entitlements-inherit']) {
          debugwarn('No `entitlements-inherit` passed in arguments, will fallback to default settings.')
          opts['entitlements-inherit'] = path.join(__dirname, 'default.mas.inherit.entitlements')
        }
      } else if (opts.platform === 'darwin') {
        // Not necessary to have entitlements for non Mac App Store distribution
        if (!opts.entitlements) {
          debugwarn('No `entitlements` passed in arguments, will not sign with entitlements.')
        } else {
          // If entitlements is provided as a flag, fallback to default
          if (opts.entitlements === true) {
            debugwarn('`entitlements` not specified in arguments, will fallback to default settings.')
            opts.entitlements = path.join(__dirname, 'default.darwin.entitlements')
          }
          if (!opts['entitlements-inherit']) {
            debugwarn('No `entitlements-inherit` passed in arguments, will fallback to default settings.')
            opts['entitlements-inherit'] = path.join(__dirname, 'default.darwin.inherit.entitlements')
          }
        }
      } else {
        return Promise.reject('Unexpected platform.')
      }
      return validateOptsBinariesAsync(opts)
    })
    .then(function () {
      if (opts.identity) {
        return findIdentityAsync(opts, opts.identity)
      }
      debugwarn('No `identity` passed in arguments, discovering identities...')
      if (opts.platform === 'mas') {
        return findIdentityAsync(opts, '3rd Party Mac Developer Application')
      } else if (opts.platform === 'darwin') {
        return findIdentityAsync(opts, 'Developer ID Application')
      } else {
        return Promise.reject('Unexpected platform.')
      }
    })
    .then(function () {
      debuglog('Signing application...')
      debuglog('> application         ' + opts.app)
      debuglog('> platform            ' + opts.platform)
      debuglog('> entitlements        ' + opts.entitlements)
      debuglog('> child-entitlements  ' + opts['entitlements-inherit'])
      debuglog('> additional-binaries ' + opts.binaries)
      debuglog('> identity            ' + opts.identity)
      return signApplicationAsync(opts)
        .then(function () {
          debuglog('Application signed.')
          return null
        })
    })
}

/**
 * This function is exported and returns a promise flattening the application.
 * @param {Object} opts - Options.
 * @returns {Promise} Promise.
 */
function flatAsync (opts) {
  if (!opts.pkg) {
    debugwarn('No `pkg` passed in arguments, will fallback to default, inferred from the given application.')
    opts.pkg = path.join(path.dirname(opts.app), path.basename(opts.app, '.app') + '.pkg')
  } else if (path.extname(opts.pkg) !== '.pkg') return Promise.reject('Extension of output package must be `.pkg`.')
  if (!opts.install) {
    debugwarn('No `install` passed in arguments, will fallback to default `/Applications`.')
    opts.install = '/Applications'
  }

  return validateOptsApplicationAsync(opts)
    .then(function () {
      return validateOptsPlatformAsync(opts)
    })
    .then(function () {
      if (opts.identity) {
        return findIdentityAsync(opts, opts.identity)
      }
      debugwarn('No `identity` passed in arguments, discovering identities...')
      if (opts.platform === 'mas') {
        return findIdentityAsync(opts, '3rd Party Mac Developer Installer')
      } else if (opts.platform === 'darwin') {
        return findIdentityAsync(opts, 'Developer ID Installer')
      } else {
        return Promise.reject('Unexpected platform.')
      }
    })
    .then(function () {
      debuglog('Flattening application...')
      debuglog('> application    ' + opts.app)
      debuglog('> package-output ' + opts.pkg)
      debuglog('> install-path   ' + opts.install)
      debuglog('> identity       ' + opts.identity)
      return flatApplicationAsync(opts)
        .then(function () {
          debuglog('Application flattened.')
          return null
        })
    })
}

/**
 * This callback is used across signing and flattening.
 * @callback RequestCallback
 * @param {mixed} err
 */

/**
 * This function is exported with normal callback implementation.
 * @param {Object} opts - Options.
 * @param {RequestCallback} cb - Callback.
 * @returns {null} Nothing.
 */
function sign (opts, cb) {
  // Default callback function if none provided
  if (!cb) {
    cb = function (err) {
      if (err) {
        debugerror('Sign failed:')
        if (err.message) debugerror(err.message)
        else if (err.stack) debugerror(err.stack)
        else debugerror(err)
        return
      }
      debuglog('Application signed: ' + opts.app)
    }
  }

  signAsync(opts)
    .then(cb)
    .catch(cb)
}

/**
 * This function is exported with normal callback implementation.
 * @param {Object} opts - Options.
 * @param {RequestCallback} cb - Callback.
 * @returns {null} Nothing.
 */
function flat (opts, cb) {
  // Default callback function if none provided
  if (!cb) {
    cb = function (err) {
      if (err) {
        debugerror('Flat failed:')
        if (err.message) debugerror(err.message)
        else if (err.stack) debugerror(err.stack)
        else debugerror(err)
        return
      }
      debuglog('Application flattened, saved to: ' + opts.app)
    }
  }

  flatAsync(opts)
    .then(cb)
    .catch(cb)
}

// Module exporting
module.exports = sign // Aliasing
module.exports.sign = sign
module.exports.signAsync = signAsync
module.exports.flat = flat
module.exports.flatAsync = flatAsync
