import * as Cucumber from 'cucumber'
import logger from '@wdio/logger'
import mockery from 'mockery'
import isGlob from 'is-glob'
import glob from 'glob'
import path from 'path'

import CucumberReporter from './reporter'
import HookRunner from './hookRunner'
import { EventEmitter } from 'events'

const log = logger('@wdio/cucumber-framework')
import { runTestInFiberContext, executeHooksWithArgs } from '@wdio/config'
import { DEFAULT_OPTS, DEFAULT_TIMEOUT } from './constants'


class CucumberAdapter {
    constructor (cid, config, specs, capabilities) {
        this.cwd = process.cwd()
        this.cid = cid
        this.specs = specs
        this.capabilities = capabilities
        this.config = config
        this.cucumberOpts = Object.assign(DEFAULT_OPTS, config.cucumberOpts)
    }

    async run () {
        Cucumber.supportCodeLibraryBuilder.reset(this.cwd)

        runTestInFiberContext(global.browser, this.config.beforeCommand, this.config.afterCommand)

        this.registerCompilers()
        this.loadSpecFiles()
        this.wrapSteps()
        Cucumber.setDefaultTimeout(this.cucumberOpts.timeout)
        const supportCodeLibrary = Cucumber.supportCodeLibraryBuilder.finalize()

        const eventBroadcaster = new EventEmitter()
        // eslint-disable-next-line no-new
        new HookRunner(eventBroadcaster, this.config)

        const reporterOptions = {
            capabilities: this.capabilities,
            ignoreUndefinedDefinitions: Boolean(this.cucumberOpts.ignoreUndefinedDefinitions),
            failAmbiguousDefinitions: Boolean(this.cucumberOpts.failAmbiguousDefinitions),
            tagsInTitle: Boolean(this.cucumberOpts.tagsInTitle)
        }
        const reporter = new CucumberReporter(eventBroadcaster, reporterOptions, this.cid, this.specs)

        const pickleFilter = new Cucumber.PickleFilter({
            featurePaths: this.spec,
            names: this.cucumberOpts.name,
            tagExpression: this.cucumberOpts.tagExpression
        })
        const testCases = await Cucumber.getTestCasesFromFilesystem({
            cwd: this.cwd,
            eventBroadcaster,
            featurePaths: this.specs,
            order: this.cucumberOpts.order,
            pickleFilter
        })
        const runtime = new Cucumber.Runtime({
            eventBroadcaster,
            options: this.cucumberOpts,
            supportCodeLibrary,
            testCases
        })

        await executeHooksWithArgs(this.config.before, [this.capabilities, this.specs])
        const result = await runtime.start() ? 0 : 1
        await executeHooksWithArgs(this.config.after, [result, this.capabilities, this.specs])
        await reporter.waitUntilSettled()

        return result
    }

    registerCompilers () {
        this.cucumberOpts.compiler.forEach(compiler => {
            const parts = compiler.split(':')
            require(parts[1])
        })
    }

    requiredFiles () {
        return this.cucumberOpts.require.reduce((files, requiredFile) => {
            if (isGlob(requiredFile)) {
                return files.concat(glob.sync(requiredFile))
            } else {
                return files.concat([requiredFile])
            }
        }, [])
    }

    loadSpecFiles () {
        // we use mockery to allow people to import 'our' cucumber even though their spec files are in their folders
        // because of that we don't have to attach anything to the global object, and the current cucumber spec files
        // should just work with no changes with this framework
        mockery.enable({
            useCleanCache: true,
            warnOnReplace: false,
            warnOnUnregistered: false
        })
        mockery.registerMock('cucumber', Cucumber)
        this.requiredFiles().forEach((codePath) => {
            let absolutePath
            if (path.isAbsolute(codePath)) {
                absolutePath = codePath
            } else {
                absolutePath = path.join(process.cwd(), codePath)
            }
            // This allows rerunning a stepDefinitions file
            delete require.cache[require.resolve(absolutePath)]
            require(absolutePath)
        })
        mockery.disable()
    }

    /**
     * wraps step definition code with sync/async runner with a retry option
     */
    wrapSteps () {
        const sync = this.config.sync
        const wrapStepSync = this.wrapStepSync
        const wrapStepAsync = this.wrapStepAsync

        Cucumber.setDefinitionFunctionWrapper(function syncAsyncRetryWrapper (fn, options = {}) {
            let retryTest = isFinite(options.retry) ? parseInt(options.retry, 10) : 0
            let wrappedFunction = fn.name === 'async' || sync === false
                ? wrapStepAsync(fn, retryTest) : wrapStepSync(fn, retryTest)
            return wrappedFunction
        })
    }

    /**
     * wrap step definition to enable retry ability
     * @param  {Function} code       step definitoon
     * @param  {Number}   retryTest  amount of allowed repeats is case of a failure
     * @return {Function}            wrapped step definiton for sync WebdriverIO code
     */
    wrapStepSync (code, retryTest = 0) {
        return function (...args) {
            return new Promise((resolve, reject) => global.wdioSync(
                executeSync.bind(this, code, retryTest, args),
                (resultPromise) => resultPromise.then(resolve, reject)
            ).apply(this))
        }
    }

    /**
     * wrap step definition to enable retry ability
     * @param  {Function} code       step definitoon
     * @param  {Number}   retryTest  amount of allowed repeats is case of a failure
     * @return {Function}            wrapped step definiton for async WebdriverIO code
     */
    wrapStepAsync (code, retryTest = 0) {
        return function (...args) {
            return executeAsync.call(this, code, retryTest, args)
        }
    }
}

const _CucumberAdapter = CucumberAdapter
const adapterFactory = {}

adapterFactory.run = async function (cid, config, specs, capabilities) {
    const adapter = new _CucumberAdapter(cid, config, specs, capabilities)
    const result = await adapter.run()
    return result
}

export default adapterFactory
export { CucumberAdapter, adapterFactory }
