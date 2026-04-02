/** Shared test utilities for Lit component tests. */

/** Append a Lit element to the DOM and wait for its first render cycle. */
export async function renderEl<T extends HTMLElement>(el: T): Promise<T> {
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
  return el;
}

/** Force-set reactive @state properties and wait for Lit re-render. */
export async function setProps(
  el: HTMLElement,
  props: Record<string, unknown>
): Promise<void> {
  Object.assign(el, props);
  await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
}
