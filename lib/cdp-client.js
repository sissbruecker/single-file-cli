/*
 * Copyright 2010-2024 Gildas Lormeau
 * contact : gildas.lormeau <at> gmail.com
 * 
 * This file is part of SingleFile.
 *
 *   The code in this file is free software: you can redistribute it and/or 
 *   modify it under the terms of the GNU Affero General Public License 
 *   (GNU AGPL) as published by the Free Software Foundation, either version 3
 *   of the License, or (at your option) any later version.
 * 
 *   The code in this file is distributed in the hope that it will be useful, 
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of 
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero 
 *   General Public License for more details.
 *
 *   As additional permission under GNU AGPL version 3 section 7, you may 
 *   distribute UNMODIFIED VERSIONS OF THIS file without the copy of the GNU 
 *   AGPL normally required by section 4, provided you include this license 
 *   notice and a URL through which recipients can access the Corresponding 
 *   Source.
 */

/* global setTimeout, clearTimeout */

import { launchBrowser, closeBrowser } from "./browser.js";
import { getScriptSource, getHookScriptSource } from "./single-file-script.js";
import { CDP, options } from "simple-cdp";

const LOAD_TIMEOUT_ERROR = "ERR_LOAD_TIMEOUT";
const NETWORK_STATES = ["InteractiveTime", "networkIdle", "networkAlmostIdle", "load", "DOMContentLoaded"];
const MINIMIZED_WINDOW_STATE = "minimized";
const SINGLE_FILE_WORLD_NAME = "singlefile";
const EMPTY_PAGE_URL = "about:blank";

export { initialize, getPageData, closeBrowser };

async function initialize(singleFileOptions) {
	if (options.browserRemoteDebuggingURL) {
		options.apiUrl = singleFileOptions.browserRemoteDebuggingURL;
	} else {
		options.apiUrl = "http://localhost:" + (await launchBrowser(getBrowserOptions(singleFileOptions)));
	}
}

async function getPageData(options) {
	let targetInfo;
	try {
		targetInfo = await CDP.createTarget(EMPTY_PAGE_URL);
		const { Browser, Security, Page, Emulation, Fetch, Network, Runtime, Debugger } = new CDP(targetInfo);
		if (options.browserStartMinimized) {
			const { windowId, bounds } = await Browser.getWindowForTarget({ targetId: targetInfo.id });
			if (bounds.windowState !== MINIMIZED_WINDOW_STATE) {
				await Browser.setWindowBounds({ windowId, bounds: { windowState: MINIMIZED_WINDOW_STATE } });
			}
		}
		if (options.browserIgnoreHTTPSErrors !== undefined && options.browserIgnoreHTTPSErrors) {
			await Security.setIgnoreCertificateErrors({ ignore: true });
		}
		if (options.browserByPassCSP === undefined || options.browserByPassCSP) {
			await Page.setBypassCSP({ enabled: true });
		}
		if (options.browserMobileEmulation) {
			await Emulation.setDeviceMetricsOverride({ mobile: true });
		}
		if (options.httpProxyUsername) {
			await Fetch.enable({ handleAuthRequests: true });
			Fetch.addEventListener("authRequired", ({ params }) => Fetch.continueWithAuth({
				requestId: params.requestId,
				authChallengeResponse: {
					response: "ProvideCredentials",
					username: options.httpProxyUsername,
					password: options.httpProxyPassword
				}
			}));
			Fetch.addEventListener("requestPaused", ({ params }) => Fetch.continueRequest({ requestId: params.requestId }));
		}
		if (options.httpHeaders && options.httpHeaders.length) {
			await Network.setExtraHTTPHeaders({ headers: options.httpHeaders });
		}
		if (options.emulateMediaFeatures) {
			for (const mediaFeature of options.emulateMediaFeatures) {
				await Emulation.setEmulatedMedia({
					media: mediaFeature.name,
					features: mediaFeature.value.split(",").map(feature => feature.trim())
				});
			}
		}
		if (options.browserCookies && options.browserCookies.length) {
			await Network.setCookies({ cookies: options.browserCookies });
		}
		await Page.addScriptToEvaluateOnNewDocument({
			source: getHookScriptSource(),
			runImmediately: true
		});
		await Page.addScriptToEvaluateOnNewDocument({
			source: await getScriptSource(options),
			runImmediately: true,
			worldName: SINGLE_FILE_WORLD_NAME
		});
		const [contextId] = await Promise.all([
			loadPage({ Page, Runtime }, options),
			options.browserDebug ? waitForDebuggerReady({ Debugger }) : Promise.resolve()
		]);
		if (options.browserWaitDelay) {
			setTimeout(() => resolve, options.browserWaitDelay);
		}
		const { result } = await Runtime.evaluate({
			expression: `singlefile.getPageData(${JSON.stringify(options)})`,
			awaitPromise: true,
			returnByValue: true,
			contextId
		});
		const { value, subtype, description } = result;
		if (subtype === "error") {
			throw new Error(description);
		}
		if (Array.isArray(value.content)) {
			value.content = new Uint8Array(value.content);
		}
		return value;
	} catch (error) {
		if (error.code === LOAD_TIMEOUT_ERROR && options.browserWaitUntilFallback && options.browserWaitUntil) {
			const browserWaitUntil = NETWORK_STATES[(NETWORK_STATES.indexOf(options.browserWaitUntil) + 1)];
			if (browserWaitUntil) {
				options.browserWaitUntil = browserWaitUntil;
				return await getPageData(options);
			}
		}
		throw error;
	} finally {
		if (targetInfo && !options.browserDebug) {
			await CDP.closeTarget(targetInfo.id);
		}
	}
}

async function loadPage({ Page, Runtime }, options) {
	await Runtime.enable();
	await Page.enable();
	const loadTimeoutAbortController = new AbortController();
	const loadTimeoutAbortSignal = loadTimeoutAbortController.signal;
	try {
		const [contextId] = await Promise.race([
			Promise.all([getTopFrameContextId({ Page, Runtime }, options), Page.navigate({ url: options.url })]),
			waitForLoadTimeout(loadTimeoutAbortSignal, options.browserLoadMaxTime)
		]);
		return contextId;
	} finally {
		if (!loadTimeoutAbortSignal.aborted) {
			loadTimeoutAbortController.abort();
		}
		await Runtime.disable();
		await Page.disable();
	}
}

async function getTopFrameContextId({ Page, Runtime }, options) {
	const CONTEXT_CREATED_EVENT = "executionContextCreated";
	const contextIds = [];
	let topFrameId;
	try {
		Runtime.addEventListener(CONTEXT_CREATED_EVENT, onExecutionContextCreated);
		await waitForPageReady({ Page }, options);
		const contextId = await getContextId();
		if (contextId === undefined) {
			throw new Error("Execution context not found");
		} else {
			return contextId;
		}
	} finally {
		Runtime.removeEventListener(CONTEXT_CREATED_EVENT, onExecutionContextCreated);
	}

	function onExecutionContextCreated({ params }) {
		const { context } = params;
		const { name, auxData = {} } = context;
		if (name === SINGLE_FILE_WORLD_NAME && topFrameId !== undefined && auxData.frameId === topFrameId) {
			contextIds.unshift(context.id);
		}
	}

	async function waitForPageReady({ Page }, options) {
		await Page.setLifecycleEventsEnabled({ enabled: true });
		try {
			await new Promise((resolve, reject) => {
				const LIFE_CYCLE_EVENT = "lifecycleEvent";
				const FRAME_NAVIGATED_EVENT = "frameNavigated";
				Page.addEventListener(LIFE_CYCLE_EVENT, onLifecycleEvent);
				Page.addEventListener(FRAME_NAVIGATED_EVENT, onFrameNavigated);

				function onLifecycleEvent({ params }) {
					const { frameId, name } = params;
					if (frameId === topFrameId && name === options.browserWaitUntil) {
						removeListeners();
						resolve();
					}
				}

				function onFrameNavigated({ params }) {
					const { frame } = params;
					if (!frame.parentId) {
						if (frame.unreachableUrl) {
							removeListeners();
							reject(new Error("Unreachable URL: " + frame.unreachableUrl));
						} else {
							topFrameId = frame.id;
						}
					}
				}

				function removeListeners() {
					Page.removeEventListener(LIFE_CYCLE_EVENT, onLifecycleEvent);
					Page.removeEventListener(FRAME_NAVIGATED_EVENT, onFrameNavigated);
				}
			});
		} finally {
			await Page.setLifecycleEventsEnabled({ enabled: false });
		}
	}

	async function getContextId() {
		let contextId;
		if (contextIds.length) {
			let contextIdIndex = 0;
			do {
				if (await testExecutionContext(contextIds[contextIdIndex])) {
					contextId = contextIds[contextIdIndex];
				}
				contextIdIndex++;
			} while (contextId === undefined && contextIdIndex < contextIds.length);
		}
		return contextId;
	}

	async function testExecutionContext(contextId) {
		try {
			const { result } = await Runtime.evaluate({
				expression: "singlefile !== undefined",
				contextId
			});
			return result.value === true;
		} catch (error) {
			// ignored
		}
		return false;
	}
}

function waitForLoadTimeout(abortSignal, maxDelay) {
	return new Promise((resolve, reject) => {
		const ABORT_EVENT = "abort";
		abortSignal.addEventListener(ABORT_EVENT, onAbort);
		const timeoutId = setTimeout(() => {
			abortSignal.removeEventListener(ABORT_EVENT, onAbort);
			const error = new Error("Load timeout");
			error.code = LOAD_TIMEOUT_ERROR;
			reject(error);
		}, maxDelay);

		function onAbort() {
			abortSignal.removeEventListener(ABORT_EVENT, onAbort);
			clearTimeout(timeoutId);
			resolve();
		}
	});
}

async function waitForDebuggerReady({ Debugger }) {
	await Debugger.enable();
	try {
		await Debugger.pause();
		await new Promise(resolve => {
			const RESUMED_EVENT = "resumed";
			Debugger.addEventListener(RESUMED_EVENT, onResumed);

			function onResumed() {
				Debugger.removeEventListener(RESUMED_EVENT, onResumed);
				resolve();
			}
		});
	} finally {
		await Debugger.disable();
	}
}

function getBrowserOptions(options) {
	const browserOptions = {};
	browserOptions.args = options.browserArgs;
	browserOptions.headless = options.browserHeadless;
	browserOptions.executablePath = options.browserExecutablePath;
	browserOptions.debug = options.browserDebug;
	browserOptions.disableWebSecurity = options.browserDisableWebSecurity === undefined || options.browserDisableWebSecurity;
	browserOptions.width = options.browserWidth;
	browserOptions.height = options.browserHeight;
	browserOptions.userAgent = options.userAgent;
	browserOptions.httpProxyServer = options.httpProxyServer;
	return browserOptions;
}