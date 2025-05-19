const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const zlib = require('zlib');
const stream = require('stream');
const cheerio = require('cheerio');

const PROXY_PORT = process.env.PORT || 8080;
const PROXY_HOST = 'localhost';

const PROXY_REJECT_UNAUTHORIZED = false;

function getProxyUrl(targetToProxy, currentFullProxyUrlFromServer) {
    if (!currentFullProxyUrlFromServer) {
        console.error(`Comet: getProxyUrl: currentFullProxyUrlFromServer is undefined!`);
        const tempBase = `http://${PROXY_HOST}:${PROXY_PORT}/proxy`;
        return `${tempBase}?url=${encodeURIComponent(targetToProxy)}`;
    }
    const proxyUrl = new URL(currentFullProxyUrlFromServer);
    const newSearchParams = new URLSearchParams();
    newSearchParams.set('url', targetToProxy);
    proxyUrl.search = newSearchParams.toString();
    return proxyUrl.toString();
}

function makeAbsoluteUrl(base, relative) {
    try {
        return new URL(relative, base).toString();
    } catch (e) {
        return relative;
    }
}

function getInjectedScript(targetPageOriginForJs, currentFullProxyUrlFromServerForJs) {
    const proxyRequestURL = new URL(currentFullProxyUrlFromServerForJs);
    const PROXY_BASE_PATH_URL = `${proxyRequestURL.origin}${proxyRequestURL.pathname}`;

    return `
<script>
    (function() {
        const PROXY_BASE_PATH_URL = '${PROXY_BASE_PATH_URL}';
        const PROXY_PREFIX = PROXY_BASE_PATH_URL + '?url=';
        const TARGET_PAGE_ORIGIN = '${targetPageOriginForJs}';
        const rawWindowLocation = window.location;

        let realTargetHref;
        try {
            const currentProxyUrlParams = new URLSearchParams(rawWindowLocation.search);
            const encodedTargetUrl = currentProxyUrlParams.get('url');
            realTargetHref = encodedTargetUrl ? decodeURIComponent(encodedTargetUrl) : TARGET_PAGE_ORIGIN;
        } catch(e) { realTargetHref = TARGET_PAGE_ORIGIN; }

        const _targetLocation = new URL(realTargetHref);

        function makeAbsoluteOnClient(url, base = _targetLocation.href) {
            if (typeof url !== 'string' || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:')) return url;
            try { return new URL(url, base).toString(); } catch (e) { return url; }
        }

        function rewriteUrl(originalUrl) {
            if (typeof originalUrl !== 'string' || originalUrl.startsWith('data:') || originalUrl.startsWith('blob:') || originalUrl.startsWith('javascript:') || originalUrl.startsWith(PROXY_BASE_PATH_URL)) {
                 return originalUrl;
            }
            return PROXY_PREFIX + encodeURIComponent(makeAbsoluteOnClient(originalUrl));
        }

        function navigate(rawNavFunction, url) {
            if (typeof url === 'string' && (url.startsWith(PROXY_BASE_PATH_URL) || url.startsWith('javascript:') || url.startsWith('mailto:') || url.startsWith('tel:'))) {
                rawNavFunction(url);
            } else {
                rawNavFunction(rewriteUrl(url));
            }
        }

        const originalWindowOpen = window.open;
        window.open = (url, name, features) => originalWindowOpen.call(window, url ? rewriteUrl(url) : url, name, features);

        const originalFetch = window.fetch;
        window.fetch = async function(input, init) {
            let originalRequestUrlForResponse, rewrittenInput = input;
            if (typeof input === 'string') {
                originalRequestUrlForResponse = input;
                rewrittenInput = rewriteUrl(input);
            } else if (input instanceof Request) {
                originalRequestUrlForResponse = input.url;
                rewrittenInput = new Request(rewriteUrl(input.url), { ...input });
            }
            const response = await originalFetch.call(window, rewrittenInput, init);
            if (response && originalRequestUrlForResponse) {
                const finalProxiedUrlHeader = response.headers.get('X-Proxied-Final-Url');
                const finalTargetUrl = finalProxiedUrlHeader ? decodeURIComponent(finalProxiedUrlHeader) : makeAbsoluteOnClient(originalRequestUrlForResponse);
                try { Object.defineProperty(response, 'url', { value: finalTargetUrl, writable: false, configurable: true }); } catch(e) {}
            }
            return response;
        };

        const originalXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
            this._originalUrlForProxy = url;
            return originalXhrOpen.call(this, method, url ? rewriteUrl(url) : url, async, user, password);
        };
        const xhrResponseURLDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseURL');
        if (xhrResponseURLDesc && xhrResponseURLDesc.get) {
            Object.defineProperty(XMLHttpRequest.prototype, 'responseURL', {
                get: function() {
                    const finalProxiedUrlHeader = this.getResponseHeader('X-Proxied-Final-Url');
                    if (finalProxiedUrlHeader) return decodeURIComponent(finalProxiedUrlHeader);
                    return this._originalUrlForProxy ? makeAbsoluteOnClient(this._originalUrlForProxy) : xhrResponseURLDesc.get.call(this);
                }
            });
        }

        const propertyRewriters = {
            default: (v) => rewriteUrl(v),
            ping: (v) => v.split(/\s+/).map(url => rewriteUrl(makeAbsoluteOnClient(url.trim()))).join(' '),
            srcset: (v) => v.split(',').map(part => {
                part = part.trim();
                const [url, ...descriptors] = part.split(/\s+/);
                return url ? rewriteUrl(makeAbsoluteOnClient(url)) + (descriptors.length > 0 ? ' ' + descriptors.join(' ') : '') : part;
            }).join(', '),
        };
        const elementsAndProps = {
            HTMLAnchorElement: { href: 'default', ping: 'ping' }, HTMLAreaElement: { href: 'default', ping: 'ping' },
            HTMLModElement: { cite: 'default' }, HTMLQuoteElement: { cite: 'default' },
            HTMLScriptElement: { src: 'default' }, HTMLLinkElement: { href: 'default' },
            HTMLImageElement: { src: 'default', srcset: 'srcset', longDesc: 'default' },
            HTMLSourceElement: { src: 'default', srcset: 'srcset' }, HTMLTrackElement: { src: 'default' },
            HTMLIFrameElement: { src: 'default', longDesc: 'default' }, HTMLFrameElement: { src: 'default', longDesc: 'default' },
            HTMLFormElement: { action: 'default' },
            HTMLInputElement: { src: 'default', formaction: 'default' },
            HTMLButtonElement: { formaction: 'default' },
            HTMLObjectElement: { data: 'default', codebase: 'default' }, HTMLEmbedElement: { src: 'default' },
        };
        for (const elName in elementsAndProps) {
            if (window[elName] && window[elName].prototype) {
                const props = elementsAndProps[elName];
                for (const propName in props) {
                    const proto = window[elName].prototype;
                    const originalDescriptor = Object.getOwnPropertyDescriptor(proto, propName);
                    const rewriterFunc = propertyRewriters[props[propName]] || propertyRewriters.default;

                    if (originalDescriptor && originalDescriptor.set) {
                        Object.defineProperty(proto, propName, {
                            configurable: true, enumerable: originalDescriptor.enumerable,
                            get: function() { return originalDescriptor.get.call(this); },
                            set: function(value) { originalDescriptor.set.call(this, (typeof value === 'string') ? rewriterFunc(value) : value); }
                        });
                    } else if (originalDescriptor && originalDescriptor.configurable || !originalDescriptor && proto.hasOwnProperty(propName) === false) {
                         Object.defineProperty(proto, propName, {
                            configurable: true, enumerable: true,
                            get: function() { return this.getAttribute(propName); },
                            set: function(value) { this.setAttribute(propName, (typeof value === 'string') ? rewriterFunc(value) : value); }
                        });
                    }
                }
            }
        }

        const locationProxyHandler = {
            assign: function(url) { navigate(rawWindowLocation.assign.bind(rawWindowLocation), url); },
            replace: function(url) { navigate(rawWindowLocation.replace.bind(rawWindowLocation), url); },
            reload: function(forcedReload) { rawWindowLocation.reload(forcedReload); },
            get href() { return _targetLocation.href; },
            set href(url) { navigate(u => rawWindowLocation.href = u, url); },
            get protocol() { return _targetLocation.protocol; },
            get host() { return _targetLocation.host; },
            get hostname() { return _targetLocation.hostname; },
            get port() { return _targetLocation.port; },
            get pathname() { return _targetLocation.pathname; },
            set pathname(val) { const u = new URL(_targetLocation.href); u.pathname = val; navigate(navUrl => rawWindowLocation.href = navUrl, u.toString()); },
            get search() { return _targetLocation.search; },
            set search(val) { const u = new URL(_targetLocation.href); u.search = val; navigate(navUrl => rawWindowLocation.href = navUrl, u.toString()); },
            get hash() { return _targetLocation.hash; },
            set hash(val) { const u = new URL(_targetLocation.href); u.hash = val; navigate(navUrl => rawWindowLocation.href = navUrl, u.toString()); },
            get origin() { return _targetLocation.origin; },
            toString: () => _targetLocation.href,
        };

        const locationProxyInstance = new Proxy(_targetLocation, {
            get: (target, prop) => {
                if (locationProxyHandler.hasOwnProperty(prop)) {
                    const val = locationProxyHandler[prop];
                    return typeof val === 'function' ? val.bind(locationProxyHandler) : val;
                }
                const targetProp = target[prop];
                return typeof targetProp === 'function' ? targetProp.bind(target) : targetProp;
            },
            set: (target, prop, value) => {
                if (prop === 'href') {
                    locationProxyHandler.href = value;
                    return true;
                }
                try { target[prop] = value; } catch(e) {  }
                return true;
            }
        });

        try {
            Object.defineProperty(window, 'location', {
                configurable: true,
                get: () => locationProxyInstance,
                set: (url) => { navigate(u => rawWindowLocation.href = u, url); }
            });
        } catch(e) { console.error("Comet" + ": Failed to redefine window.location", e); }

        try { Object.defineProperty(document, 'domain', { get: () => _targetLocation.hostname, set: (val) => {} }); } catch(e) {}
        try { Object.defineProperty(document, 'URL', { get: () => _targetLocation.href }); } catch(e) {}
        try { Object.defineProperty(document, 'documentURI', { get: () => _targetLocation.href }); } catch(e) {}
        try { Object.defineProperty(document, 'baseURI', { get: () => _targetLocation.href }); } catch(e) {}

        ['pushState', 'replaceState'].forEach(method => {
            const original = history[method];
            history[method] = (state, title, url) => original.call(history, state, title, url ? rewriteUrl(makeAbsoluteOnClient(url.toString())) : url);
        });

        if (navigator.sendBeacon) {
            const originalSendBeacon = navigator.sendBeacon;
            navigator.sendBeacon = (url, data) => originalSendBeacon.call(navigator, rewriteUrl(url), data);
        }

        if (window.EventSource) {
            const OriginalEventSource = window.EventSource;
            window.EventSource = function(url, eventSourceInitDict) { return new OriginalEventSource(rewriteUrl(url), eventSourceInitDict); };
            if (OriginalEventSource.prototype) window.EventSource.prototype = OriginalEventSource.prototype;
        }

        if (window.WebSocket) {  }

        document.addEventListener('submit', function(event) {
            const form = event.target;
            const baseForResolution = _targetLocation.href;

            let effectiveUnproxiedActionUrl;
            let actionSourceAttribute = null;
            let formMethod = form.method;

            if (event.submitter) {
                if (event.submitter.hasAttribute('formaction')) actionSourceAttribute = event.submitter.getAttribute('formaction');
                if (event.submitter.hasAttribute('formmethod')) formMethod = event.submitter.getAttribute('formmethod');
            }
            if (!actionSourceAttribute && form.hasAttribute('action')) {
                actionSourceAttribute = form.getAttribute('action');
            }

            if (actionSourceAttribute) {
                if (actionSourceAttribute.startsWith(PROXY_BASE_PATH_URL + '?url=')) {
                    try {
                        const proxiedUrlParams = new URLSearchParams(new URL(actionSourceAttribute, PROXY_BASE_PATH_URL).search);
                        effectiveUnproxiedActionUrl = decodeURIComponent(proxiedUrlParams.get('url'));
                    } catch (e) { effectiveUnproxiedActionUrl = makeAbsoluteOnClient(baseForResolution); }
                } else {
                    effectiveUnproxiedActionUrl = makeAbsoluteOnClient(actionSourceAttribute, baseForResolution);
                }
            } else {
                effectiveUnproxiedActionUrl = makeAbsoluteOnClient(baseForResolution);
            }

            const method = (formMethod || 'get').toLowerCase();

            if (method === 'get') {
                event.preventDefault();
                const formData = event.submitter ? new FormData(form, event.submitter) : new FormData(form);
                const finalTargetGetUrl = new URL(effectiveUnproxiedActionUrl);
                new URLSearchParams(formData).forEach((value, key) => {
                    finalTargetGetUrl.searchParams.append(key, value);
                });
                locationProxyHandler.href = finalTargetGetUrl.toString();
            } else {
                const desiredProxiedAction = PROXY_PREFIX + encodeURIComponent(effectiveUnproxiedActionUrl);
                if (form.getAttribute('action') !== desiredProxiedAction) {
                     form.setAttribute('action', desiredProxiedAction);
                }
            }
        }, true);

        const originalFormSubmit = HTMLFormElement.prototype.submit;
        HTMLFormElement.prototype.submit = function(submitter) {
            const event = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter instanceof HTMLElement ? submitter : undefined });
            if (this.dispatchEvent(event)) { originalFormSubmit.call(this); }
        };
        if (HTMLFormElement.prototype.requestSubmit) {
            const originalFormRequestSubmit = HTMLFormElement.prototype.requestSubmit;
            HTMLFormElement.prototype.requestSubmit = function(submitter) {
                const event = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter });
                if (this.dispatchEvent(event)) { originalFormRequestSubmit.call(this, submitter); }
            };
        }

        const actualDocumentCookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
                                             Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
        if (actualDocumentCookieDescriptor && actualDocumentCookieDescriptor.get && actualDocumentCookieDescriptor.set) {
            Object.defineProperty(document, 'cookie', {
                configurable: true,
                enumerable: true,
                get: function() {
                    return actualDocumentCookieDescriptor.get.call(document);
                },
                set: function(value) {
                    let parts = value.split(';').map(p => p.trim());
                    let newCookieString = parts[0];
                    let pathFound = false;
                    for (let i = 1; i < parts.length; i++) {
                        const [attrName] = parts[i].split('=');
                        const lowerAttrName = attrName.toLowerCase();
                        if (lowerAttrName === 'domain') continue;
                        if (lowerAttrName === 'path') {
                            newCookieString += '; Path=/';
                            pathFound = true;
                            continue;
                        }
                        newCookieString += '; ' + parts[i];
                    }
                    if (!pathFound) newCookieString += '; Path=/';
                    actualDocumentCookieDescriptor.set.call(document, newCookieString);
                }
            });
        }
        console.log(\`Comet active. Target Origin: \${targetPageOriginForJs}, Proxy Base: \${PROXY_BASE_PATH_URL}, Real Target Href: \${_targetLocation.href}\`);
    })();
</script>
`;
}

function rewriteAttributeInternal(attrValue, attrName, elTagName, targetPageFullUrl, currentFullProxyUrl) {
    if (!attrValue || /^(javascript:|mailto:|tel:|data:|blob:|#)/i.test(attrValue)) {
        return attrValue;
    }
    const makeAbs = (url) => makeAbsoluteUrl(targetPageFullUrl, url.trim());
    const proxify = (url) => getProxyUrl(url, currentFullProxyUrl);

    if (attrName === 'srcset') {
        return attrValue.split(',')
            .map(part => {
                const [url, ...descriptors] = part.trim().split(/\s+/);
                return url ? proxify(makeAbs(url)) + (descriptors.length > 0 ? ' ' + descriptors.join(' ') : '') : part.trim();
            }).join(', ');
    } else if (attrName === 'ping' || (attrName === 'archive' && (elTagName === 'object' || elTagName === 'applet'))) {
        return attrValue.split(/\s+/)
            .map(url => proxify(makeAbs(url)))
            .join(' ');
    } else {
        return proxify(makeAbs(attrValue));
    }
}

function rewriteHtml(htmlBuffer, targetPageFullUrl, currentFullProxyUrl) {
    const $ = cheerio.load(htmlBuffer.toString('utf8'));

    const attributesToRewrite = {
        'a': ['href', 'ping'], 'area': ['href', 'ping'], 'link': ['href'],
        'script': ['src'], 'img': ['src', 'srcset', 'longdesc'],
        'video': ['poster', 'src'], 'audio': ['src'],
        'iframe': ['src', 'longdesc'], 'frame': ['src', 'longdesc'],
        'form': ['action'], 'input': ['src', 'formaction'], 'button': ['formaction'],
        'object': ['data', 'codebase', 'classid', 'archive'], 'embed': ['src'],
        'source': ['src', 'srcset'], 'track': ['src'],
        'blockquote': ['cite'], 'q': ['cite'], 'del': ['cite'], 'ins': ['cite'],
        'applet': ['codebase', 'archive', 'code'],
    };

    Object.entries(attributesToRewrite).forEach(([selector, attrs]) => {
        $(selector).each((i, el) => {
            const elCheerio = $(el);
            attrs.forEach(attrName => {
                const originalValue = elCheerio.attr(attrName);
                if (originalValue) {
                    elCheerio.attr(attrName, rewriteAttributeInternal(originalValue, attrName, selector, targetPageFullUrl, currentFullProxyUrl));
                }
            });
        });
    });

    $('input[type="hidden"]').each((i, el) => {
        const originalValue = $(el).attr('value');
        if (originalValue && /^(https?:\/\/|\/\/|\/)/i.test(originalValue) && !/^(data:|blob:)/i.test(originalValue)) {
            try {
                new URL(originalValue, targetPageFullUrl);
                $(el).attr('value', getProxyUrl(makeAbsoluteUrl(targetPageFullUrl, originalValue), currentFullProxyUrl));
            } catch (e) {  }
        }
    });

    $('[style]').each((i, el) => {
        let style = $(el).attr('style');
        if (style && style.includes('url(')) {
            style = style.replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, url) => {
                if (/^(data:|#)/i.test(url)) return match;
                return `url(${quote}${getProxyUrl(makeAbsoluteUrl(targetPageFullUrl, url), currentFullProxyUrl)}${quote})`;
            });
            $(el).attr('style', style);
        }
    });

    $('meta[http-equiv="refresh"]').each((i, el) => {
        const content = $(el).attr('content');
        if (content) {
            const match = content.match(/^(\d+;\s*url=)(.*)$/i);
            if (match && match[2]) {
                $(el).attr('content', `${match[1]}${getProxyUrl(makeAbsoluteUrl(targetPageFullUrl, match[2]), currentFullProxyUrl)}`);
            }
        }
    });

    $('iframe[srcdoc]').each((i, el) => {
        let srcdocContent = $(el).attr('srcdoc');
        if (srcdocContent) {
            const $srcDoc = cheerio.load(srcdocContent);
            ['a[href]', 'link[href]', 'script[src]', 'img[src]', 'form[action]'].forEach(selector => {
                 $srcDoc(selector).each((idx, childEl) => {
                    ['href', 'src', 'action'].forEach(attr => {
                        const val = $srcDoc(childEl).attr(attr);
                        if (val && !/^(data:|javascript:|#)/i.test(val)) {
                            $srcDoc(childEl).attr(attr, getProxyUrl(makeAbsoluteUrl(targetPageFullUrl, val), currentFullProxyUrl));
                        }
                    });
                });
            });
            $(el).attr('srcdoc', $srcDoc.html());
        }
    });

    $('base').remove();
    $('[integrity]').removeAttr('integrity');
    const targetPageOrigin = new URL(targetPageFullUrl).origin;
    $('head').prepend(getInjectedScript(targetPageOrigin, currentFullProxyUrl));

    return Buffer.from($.html(), 'utf8');
}

function rewriteCss(cssBuffer, targetPageFullUrl, currentFullProxyUrl) {
    let css = cssBuffer.toString('utf8');
    const proxifyUrlInCss = (url) => {
        if (/^(data:|#)/i.test(url)) return url;
        return getProxyUrl(makeAbsoluteUrl(targetPageFullUrl, url.trim()), currentFullProxyUrl);
    };
    css = css.replace(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, url) => `url(${quote}${proxifyUrlInCss(url)}${quote})`);
    css = css.replace(/@import\s+(['"]?)((?:url\((?:['"]?)(.*?)(?:['"]?)\))|(?:[^ ;"']+))\1\s*(;|$)/gi,
        (match, outerQuote, fullUrlOrPath, innerUrlFromParen, endChar) => {
        const urlToRewrite = (innerUrlFromParen || fullUrlOrPath).trim();
        if (/^data:/i.test(urlToRewrite)) return match;
        const rewritten = proxifyUrlInCss(urlToRewrite);
        return `@import ${outerQuote || '"'}${rewritten}${outerQuote || '"'}${endChar}`;
    });
    return Buffer.from(css, 'utf8');
}

function rewriteJsonLike(jsonBuffer, targetPageFullUrl, currentFullProxyUrl) {
    let jsonString = jsonBuffer.toString('utf8');

    const hijackingPrefixRegex = /^\s*(\)]}'|\]\}\')\s*/;
    if (hijackingPrefixRegex.test(jsonString)) {
        jsonString = jsonString.replace(hijackingPrefixRegex, '');
    }

    try {
        const obj = JSON.parse(jsonString);
        function traverseAndRewrite(currentObj) {
            for (const key in currentObj) {
                if (!Object.prototype.hasOwnProperty.call(currentObj, key)) continue;
                const value = currentObj[key];
                if (typeof value === 'string' && /^(https?:\/\/|\/\/|\.\.?\/|\/)/i.test(value) && !/^(data:|blob:)/i.test(value)) {
                    try {
                        new URL(value, targetPageFullUrl);
                        currentObj[key] = getProxyUrl(makeAbsoluteUrl(targetPageFullUrl, value), currentFullProxyUrl);
                    } catch (e) {  }
                } else if (typeof value === 'object' && value !== null) {
                    traverseAndRewrite(value);
                }
            }
        }
        traverseAndRewrite(obj);
        return Buffer.from(JSON.stringify(obj), 'utf8');
    } catch (e) {
        console.warn(`Comet: Failed to parse/rewrite JSON-like content:`, e.message);
        return jsonBuffer;
    }
}

function rewriteSvg(svgBuffer, targetPageFullUrl, currentFullProxyUrl) {
    try {
        const $ = cheerio.load(svgBuffer.toString('utf8'), { xmlMode: true });
        $('image, use').each((i, el) => {
            ['href', 'xlink:href'].forEach(attr => {
                const val = $(el).attr(attr);
                if (val && !/^(#|data:)/i.test(val)) {
                    $(el).attr(attr, getProxyUrl(makeAbsoluteUrl(targetPageFullUrl, val), currentFullProxyUrl));
                }
            });
        });
        $('style').each((i, el) => {
            const styleContent = $(el).html();
            if (styleContent) {
                $(el).html(rewriteCss(Buffer.from(styleContent), targetPageFullUrl, currentFullProxyUrl).toString('utf8'));
            }
        });
        return Buffer.from($.html(), 'utf8');
    } catch(e) {
        console.warn(`Comet: Failed to parse/rewrite SVG content:`, e.message);
        return svgBuffer;
    }
}

const server = http.createServer(async (clientReq, clientRes) => {
    const currentFullProxyUrlFromServer = `http://${PROXY_HOST}:${PROXY_PORT}${clientReq.url}`;
    const parsedProxyUrl = new URL(currentFullProxyUrlFromServer);

    if (parsedProxyUrl.pathname !== '/proxy') {
        clientRes.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found. Use /proxy?url=<target_url>');
        return;
    }

    const initialTargetUrlFromParam = parsedProxyUrl.searchParams.get('url');
    if (!initialTargetUrlFromParam) {
        clientRes.writeHead(400, { 'Content-Type': 'text/plain' }).end('Missing "url" query parameter.');
        return;
    }

    let initialTargetUrlObject;
    try {
        initialTargetUrlObject = new URL(initialTargetUrlFromParam);
    } catch (e) {
        clientRes.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Invalid base target URL: ${initialTargetUrlFromParam}`);
        return;
    }
    const targetPageFullUrlForAssetResolution = initialTargetUrlObject.href;
    const targetOrigin = initialTargetUrlObject.origin;

    let finalTargetUrlToFetch = targetPageFullUrlForAssetResolution;
    if (clientReq.method === 'GET') {
        const reconstructedTarget = new URL(targetPageFullUrlForAssetResolution);
        parsedProxyUrl.searchParams.forEach((value, key) => {
            if (key !== 'url') reconstructedTarget.searchParams.append(key, value);
        });
        finalTargetUrlToFetch = reconstructedTarget.toString();
    }

    let targetUrlObjectToFetch;
    try {
        targetUrlObjectToFetch = new URL(finalTargetUrlToFetch);
    } catch (e) {
        clientRes.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Invalid final target URL: ${finalTargetUrlToFetch}`);
        return;
    }

    const outgoingHeaders = { ...clientReq.headers };
    outgoingHeaders['host'] = targetUrlObjectToFetch.host;
    outgoingHeaders['origin'] = targetOrigin;
    outgoingHeaders['accept-encoding'] = 'gzip, deflate';

    if (clientReq.headers['referer']) {
        try {
            const originalReferer = new URL(clientReq.headers['referer']).searchParams.get('url');
            outgoingHeaders['referer'] = originalReferer ? originalReferer : targetOrigin + '/';
        } catch (e) { outgoingHeaders['referer'] = targetOrigin + '/'; }
    } else {
        outgoingHeaders['referer'] = targetOrigin + '/';
    }

    const headersToRemoveClient = new Set(['connection', 'if-modified-since', 'if-none-match', 'cache-control', 'upgrade-insecure-requests', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);
    const clientContentType = (clientReq.headers['content-type'] || '').toLowerCase();
    const isRewritableTypeForRange = clientContentType.includes('html') || clientContentType.includes('css') ||
                                     clientContentType.includes('javascript') || clientContentType.includes('json') ||
                                     clientContentType.includes('svg');
    if (outgoingHeaders['range'] && isRewritableTypeForRange) {
        headersToRemoveClient.add('range');
        headersToRemoveClient.add('if-range');
    }
    headersToRemoveClient.forEach(h => delete outgoingHeaders[h]);

    const options = {
        hostname: targetUrlObjectToFetch.hostname,
        port: targetUrlObjectToFetch.port || (targetUrlObjectToFetch.protocol === 'https:' ? 443 : 80),
        path: targetUrlObjectToFetch.pathname + targetUrlObjectToFetch.search,
        method: clientReq.method,
        headers: outgoingHeaders,
        rejectUnauthorized: PROXY_REJECT_UNAUTHORIZED,
    };

    const protocolImpl = targetUrlObjectToFetch.protocol === 'https:' ? https : http;
    const proxyReq = protocolImpl.request(options, (targetRes) => {
        const { statusCode, headers: targetHeaders } = targetRes;
        const newHeaders = { ...targetHeaders };

        const finalUrlAfterTargetRedirects = targetRes.responseUrl || targetRes.req?.res?.responseUrl || targetUrlObjectToFetch.href;
        newHeaders['X-Proxied-Final-Url'] = encodeURIComponent(finalUrlAfterTargetRedirects);

        const contentType = (targetHeaders['content-type'] || '').toLowerCase();
        const contentEncoding = (targetHeaders['content-encoding'] || '').toLowerCase();
        const needsServerSideRewrite = contentType.includes('html') || contentType.includes('css') ||
                                   contentType.includes('javascript') ||
                                   contentType.includes('json') || contentType.includes('application/manifest+json') ||
                                   contentType.includes('svg');

        const headersToRemoveFromServer = new Set(['strict-transport-security', 'public-key-pins', 'content-security-policy-report-only', 'referrer-policy']);
        if (needsServerSideRewrite) {
            ['content-length', 'content-encoding', 'etag', 'last-modified', 'transfer-encoding'].forEach(h => headersToRemoveFromServer.add(h));
            if (newHeaders['content-security-policy']) {
                let csp = newHeaders['content-security-policy'];
                const proxySelf = `'self' ${new URL(currentFullProxyUrlFromServer).origin}`;
                csp = csp.replace(/frame-ancestors\s[^;]+;/gi, '');
                const directivesToAugment = ['script-src', 'script-src-elem', 'script-src-attr', 'style-src', 'style-src-elem', 'style-src-attr', 'img-src', 'media-src', 'font-src', 'connect-src', 'frame-src', 'worker-src', 'object-src'];
                directivesToAugment.forEach(dir => {
                    const regex = new RegExp(`(${dir}\\s)`, 'gi');
                    if (csp.match(regex)) {
                         csp = csp.replace(regex, `$1${proxySelf} ${targetOrigin} data: blob: 'unsafe-inline' `);
                    } else {
                        csp += `; ${dir} ${proxySelf} ${targetOrigin} data: blob: 'unsafe-inline'`;
                    }
                });
                if (!csp.match(/default-src\s/i)) csp += `; default-src ${proxySelf} ${targetOrigin} data: blob: 'unsafe-inline' 'unsafe-eval'`;
                else csp = csp.replace(/(default-src\s)/gi, `$1${proxySelf} ${targetOrigin} data: blob: 'unsafe-inline' 'unsafe-eval' `);

                newHeaders['content-security-policy'] = csp.replace(/\s+/g, ' ').trim().replace(/;;/g, ';');
            }
        }
        headersToRemoveFromServer.forEach(h => delete newHeaders[h]);

        if (targetHeaders['location']) {
            newHeaders['location'] = getProxyUrl(makeAbsoluteUrl(finalUrlAfterTargetRedirects, targetHeaders['location']), currentFullProxyUrlFromServer);
        }

        if (targetHeaders['set-cookie']) {
            const cookies = Array.isArray(targetHeaders['set-cookie']) ? targetHeaders['set-cookie'] : [targetHeaders['set-cookie']];
            newHeaders['set-cookie'] = cookies.map(cookieStr =>
                cookieStr.replace(/;\s*domain=[^;]+/ig, '')
                         .replace(/;\s*path=[^;]+/ig, '; path=/')
                         .replace(/;\s*secure/ig, PROXY_PORT === 443 || clientReq.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '')
                         .replace(/;\s*samesite=(lax|strict|none)/ig, (match, site) => site.toLowerCase() === 'none' && !(PROXY_PORT === 443 || clientReq.headers['x-forwarded-proto'] === 'https') ? '; SameSite=Lax' : `; SameSite=${site}`)
            );
        }

        clientRes.writeHead(statusCode, newHeaders);

        const decompressStream = (encoding) => {
            if (encoding === 'gzip') return zlib.createGunzip();
            if (encoding === 'deflate') return zlib.createInflate();
            return new stream.PassThrough();
        };
        const PipedStream = targetRes.pipe(decompressStream(contentEncoding));

        if (needsServerSideRewrite && statusCode >= 200 && statusCode < 300) {
            let bodyChunks = [];
            PipedStream.on('data', chunk => bodyChunks.push(chunk));
            PipedStream.on('error', err => { console.error(`Comet: Decompression/stream error:`, err); if (!clientRes.writableEnded) clientRes.end(); });
            PipedStream.on('end', () => {
                if (clientRes.writableEnded) return;
                let body = Buffer.concat(bodyChunks);
                try {
                    if (contentType.includes('html')) body = rewriteHtml(body, targetPageFullUrlForAssetResolution, currentFullProxyUrlFromServer);
                    else if (contentType.includes('css')) body = rewriteCss(body, targetPageFullUrlForAssetResolution, currentFullProxyUrlFromServer);
                    else if (contentType.includes('json') || contentType.includes('application/manifest+json')) body = rewriteJsonLike(body, targetPageFullUrlForAssetResolution, currentFullProxyUrlFromServer);
                    else if (contentType.includes('svg')) body = rewriteSvg(body, targetPageFullUrlForAssetResolution, currentFullProxyUrlFromServer);
                } catch (rewriteError) { console.error(`Comet: Rewrite error for ${finalTargetUrlToFetch}:`, rewriteError); }
                clientRes.end(body);
            });
        } else {
            PipedStream.pipe(clientRes);
            PipedStream.on('error', err => { console.error(`Comet: Stream pipe error for non-rewritten content:`, err); if(!clientRes.writableEnded) clientRes.end(); });
        }
    });

    proxyReq.on('error', (e) => {
        console.error(`Comet: Proxy request error for ${finalTargetUrlToFetch}: ${e.code} ${e.message}`);
        if (!clientRes.headersSent) {
            const messages = {
                'ECONNREFUSED': `Connection refused by target: ${targetUrlObjectToFetch.hostname}:${options.port}`,
                'ENOTFOUND': `Target not found: ${targetUrlObjectToFetch.hostname}`,
                'EPROTO': `SSL/TLS handshake issue with ${targetUrlObjectToFetch.hostname}. ${e.message}`,
                'ETIMEDOUT': `Connection timed out with ${targetUrlObjectToFetch.hostname}`,
                'ECONNRESET': `Connection reset by ${targetUrlObjectToFetch.hostname}`,
            };
            clientRes.writeHead(502, { 'Content-Type': 'text/plain' }).end(`Proxy error: ${messages[e.code] || e.message}`);
        } else {
            clientRes.end();
        }
    });
    clientReq.pipe(proxyReq);
});

server.listen(PROXY_PORT, PROXY_HOST, () => {
    console.log(`Server listening on http://${PROXY_HOST}:${PROXY_PORT}`);
    console.log(`Usage: http://${PROXY_HOST}:${PROXY_PORT}/proxy?url=<target_url>`);
    if (!PROXY_REJECT_UNAUTHORIZED) {
        console.warn(`\nDEVELOPMENT MODE: Comet has 'rejectUnauthorized: false' active for HTTPS targets.\nThis is insecure and should ONLY be used for local development with self-signed certificates.\nSET TO TRUE FOR PRODUCTION!\n`);
    }
});
server.on('error', (e) => console.error(`Server error:`, e));