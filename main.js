'use strict';

var findup = require('findup-sync');
var loadPlugins = require('gulp-load-plugins');
var multimatch = require('multimatch');
var _ = require('lodash');
var path = require('path');
var globby = require('globby');
var gutil = require('gulp-util');
var fs = require('fs');

// workaround for linked development modules
var prequire = require('parent-require');
var requireFn = function (module) {
    try {
        return require(module);
    }
    catch(e) {
        if(e.code === 'MODULE_NOT_FOUND') {
            try {
                return prequire(module);
            }
            catch(e2) {} // throw original error
        }
        throw e;
    }
};

// error handling
function formatError(e) {
    if (!e.err) {
        return e.message;
    }

    // PluginError
    if (typeof e.err.showStack === 'boolean') {
        return e.err.toString();
    }

    // normal error
    if (e.err.stack) {
        return e.err.stack;
    }

    // unknown (string, number, etc.)
    return new Error(String(e.err)).stack;
}

// Necessary to get the current `module.parent` and resolve paths correctly when required from multiple places.
delete require.cache[__filename];
var parentDir = path.dirname(module.parent.filename);

function camelize(str) {
    return str.replace(/-(\w)/g, function(m, p1) {
        return p1.toUpperCase();
    });
}

/**
 * Checks if at least one of devDependency directory exists
 * (to distinguish production and dev npm install)
 *
 * @param dependency
 * @returns {*}
 */
function devDependenciesExists(dependency) {
    var depExists;

    if (!dependency) {
        return false;
    }

    try {
        depExists = fs.statSync(path.join('node_modules', dependency)).isDirectory();
    }
    catch(e) {
        depExists = false;
    }

    return depExists;
}

// require gulp from outside world to prevent multiple instances. This could also be a peer dependency,
// but it gets tricky with multiple layers of modules
module.exports = function (gulp, options) {
    if(!options) {
        options = {};
    }

    var allRecipesInitalized = false;

    // set default options
    options = _.merge({
        tasks: {},
        paths: {},
        order: {},
        sources: {
            defaultBase: '.'
        },
        recipesPattern: 'gulp-recipes/{*/main.js,*.js}',
        rename: {}
    }, options);

    // read package.json or get it from options
    var packageFile = options.package || findup('package.json', {cwd: parentDir});
    if (typeof packageFile === 'string') {
        packageFile = require(packageFile);
    }

    // check for devDependencies
    var loadDevDependencies = devDependenciesExists(_.findKey(_.result(packageFile,'devDependencies')));

    // lazy load all non-recipe plugins from package.json
    var $ = loadPlugins({
        pattern: ['*', '!gulp-recipe-*', '!gulp'],
        scope: loadDevDependencies ? ['dependencies', 'devDependencies'] : ['dependencies'],
        replaceString: 'gulp-',
        camelize: true,
        lazy: true,
        config: packageFile,
        rename: options.rename,
        requireFn: requireFn
    });

    // force single gulp instance
    Object.defineProperty($, 'gulp', {value: gulp});

    // publish some internal packages to modules, if not published already
    _.each(['event-stream', 'lodash', 'through2', 'gulp-watch'], function (internal) {
        var camelized = camelize(internal.replace('gulp-',''));
        if(!$.hasOwnProperty(camelized)) {
            Object.defineProperty($, camelized, {
                get: function() {
                    return require(internal);
                }
            });
        }
    });

    // load utility functions
    $.gutil = gutil;
    $.utils = require('./utils')($);

    $.lazypipe = require('./lib/lazypipe').lazypipe;

    // resolve external recipe directories
    var externPattern = ['gulp-recipe-*', '!gulp-recipe-loader'];
    var externScope = loadDevDependencies ? ['dependencies', 'devDependencies'] : ['dependencies'];
    var replaceString = 'gulp-recipe-';
    var pluginNames = _.reduce(externScope, function(result, prop) {
        return result.concat(Object.keys(packageFile[prop] || {}));
    }, []);

    var recipeDirectory = _.transform(multimatch(pluginNames, externPattern), function (obj, name) {
        var renamed = options.rename[name] || camelize(name.replace(replaceString, ''));
        obj[renamed] = path.join(parentDir, 'node_modules', name);
    }, {});

    // lazy load all recipes from package.json
    var extPluginsConfig = {
        pattern: externPattern,
        scope: externScope,
        replaceString: replaceString,
        camelize: true,
        lazy: false,
        config: packageFile,
        rename: options.rename,
        requireFn: requireFn
    };

    var recipes = loadPlugins(extPluginsConfig);

    // load all recipes from local project directory
    var localRecipes = _.object(_.map(globby.sync(options.recipesPattern), function (module) {
        var recipeName = path.basename(module, '.js');
        if(recipeName === 'main') {
          recipeName = path.basename(path.dirname(module));
        }

        return [recipeName, require(path.join(parentDir, module))];
    }));

    // create a way to extend lib getter object with modules local libs, prefer local versions
    var LibsProto = function () {};
    LibsProto.prototype = $;

    var localLibBuilder = function (recipeName) {
        var localLibs = new LibsProto();
        var dir = recipeDirectory[recipeName];
        if(dir) {
            // find internal package.json
            var localPackageFile = require(findup('package.json', {cwd: dir}));

            // load recipe dependencies
            var localConfig = _.defaults({
                pattern: '*',
                replaceString: 'gulp-',
                config: localPackageFile,
                lazy: true,
                requireFn: function (name) {
                    // resolve inner dependency path
                    var depPath = path.join(dir, 'node_modules', name);
                    try {
                        // direct module require may fail, if dedupe was done
                        return requireFn(depPath);
                    }
                    catch(e) {
                        if(e.code === 'MODULE_NOT_FOUND') {
                            // for that occasions a regular require is sufficient
                            try {
                                return requireFn(name);
                            }
                            catch(e2) {} // throw original error
                        }
                        throw e;
                    }
                }
            }, extPluginsConfig);

            var localPlugins = loadPlugins(localConfig);

            // pass lazy properties of loaded dependencies into local $ object
            _.each(Object.getOwnPropertyNames(localPlugins), function (prop) {
                Object.defineProperty(localLibs, prop, {
                    get: function () {
                        return localPlugins[prop];
                    }
                });
            });
        }

        return localLibs;
    };

    var processSourceHook = _.once(function () {
        // This hook function is evaluated on first source pipe usage,
        // which means inside a specific task, after all recipes are successfuly loaded.
        // It's safe to grab pipe hooks from there, unles a specific plugin
        // decides to evaluate pipe before initialization. Yell at it!
        if(!allRecipesInitalized) {
            throw new $.utils.RecipeError('Stream created before all recipes are initialized.');
        }

        return $.utils.sequentialLazypipe($.utils.getPipes('processSource'));
    });

    // prepare lazy initializers for recipes, so it may be cross referenced
    $.recipes = {};
    _.each(_.merge(recipes, localRecipes), function (recipeDef, key) {
        Object.defineProperty($.recipes, key, {
            enumerable: true,
            get: _.once(function () {
                if(_.isFunction(recipeDef)) {
                    recipeDef = { recipe: recipeDef };
                }

                var localLibs, localConfig, sources;
                try {
                    // load module's local dependencies
                    localLibs = localLibBuilder(key);
                    // run config reader on given config
                    localConfig = recipeDef.configReader ? recipeDef.configReader(localLibs, _.cloneDeep(options)) : _.cloneDeep(options);
                    // prepare source pipes
                    if(localConfig.sources) {
                        if(_.isUndefined(localConfig.sources.defaultBase) && options.sources) {
                            localConfig.sources.defaultBase = options.sources.defaultBase;
                        }
                        sources = localLibs.utils.makeSources(localConfig.sources, function () {
                            return processSourceHook()();
                        });
                    }

                    return recipeDef.recipe(localLibs, localConfig, sources);
                }
                catch(e) {
                    // catch recipe errors
                    if(e instanceof $.utils.RecipeError) {
                        throw new $.utils.NamedRecipeError(key, e);
                    }
                    else {
                        throw new $.utils.NamedRecipeError(key, e, {showStack: true});
                    }
                }
            })
        });
    });

    // force load all recipes
    _.each(Object.getOwnPropertyNames($.recipes), function (key) {
        try {
            return $.recipes[key];
        }
        catch(e) {
            var msg = formatError({err: e});
            $.gutil.log(msg);
            process.exit(1);
        }
    });

    allRecipesInitalized = true;

    return $;
};
