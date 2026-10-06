/**
 * Small helpers shared across the extension.
 *
 * Reconstructed from the previously published dist/whatsThatGenre-plus.js, which
 * was built from a source tree that included this file but never committed it.
 * Behaviour is preserved; see issue #2.
 */

/** "synth-pop" / "post grunge" -> "Synth-Pop" / "PostGrunge" */
export function camelize(value: string): string {
	return value.replace(/(^\w{1})|([\s-]+\w{1})/g, (match) => match.toUpperCase());
}

/** Global string replace. */
export function replaceAll(value: string, find: string, replacement: string): string {
	return value.replace(new RegExp(find, "g"), replacement);
}

/** Trailing-edge debounce. */
export function debounce<T extends (...args: never[]) => void>(fn: T, delay = 300) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return function (this: unknown, ...args: Parameters<T>) {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => fn.apply(this, args), delay);
	};
}

/**
 * Either a CSS selector or a resolver function. The resolver form exists because
 * the now-playing markup is built from hashed class names that change between
 * Spotify releases, so a stable structural lookup is more reliable than a
 * selector. See issue #1.
 */
export type ElementTarget = string | (() => Element | null);

function resolveElement(target: ElementTarget): Element | null {
	return typeof target === "string" ? document.querySelector(target) : target();
}

/**
 * Resolve `target` now, or as soon as it appears within `timeout` ms.
 * Resolves `null` if it never appears.
 */
export function waitForElement(target: ElementTarget, timeout = 5000): Promise<Element | null> {
	return new Promise((resolve) => {
		let observer: MutationObserver;

		const attempt = () => {
			const element = resolveElement(target);
			if (element) {
				observer.disconnect();
				resolve(element);
			} else if (timeout) {
				setTimeout(() => {
					observer.disconnect();
					resolve(null);
				}, timeout);
			}
		};

		observer = new MutationObserver(attempt);
		observer.observe(document.body, { childList: true, subtree: true });
		attempt();
	});
}