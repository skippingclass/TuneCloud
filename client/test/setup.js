import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import React from 'react';
import { createRoot } from 'react-dom/client';

// Register synchronous JSX loader hook for Node test runner
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.jsx') || url.endsWith('.test.js')) {
      const filePath = fileURLToPath(url);
      const source = readFileSync(filePath, 'utf8');
      const transformed = esbuild.transformSync(source, {
        loader: 'jsx',
        jsx: 'automatic',
        format: 'esm',
        sourcemap: 'inline',
        sourcefile: filePath,
      });
      return {
        format: 'module',
        shortCircuit: true,
        source: transformed.code,
      };
    }
    return nextLoad(url, context);
  },
});

export class DOMNode {
  constructor(nodeType, nodeName, ownerDocument) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.tagName = nodeType === 1 ? nodeName.toUpperCase() : undefined;
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
    this.namespaceURI = 'http://www.w3.org/1999/xhtml';
    this.style = {
      setProperty(k, v) {
        this[k] = v;
      },
      removeProperty(k) {
        delete this[k];
      },
    };
    this.attributes = {};
    this.listeners = {};
    this.nodeValue = '';
    this.className = '';
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    };
    this.id = '';
    this.type = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;

    if (this.tagName === 'AUDIO') {
      this.paused = true;
      this.currentTime = 0;
      this.duration = 0;
      this.volume = 1;
      this.playbackRate = 1;
      this.playCalls = 0;
      this.pauseCalls = 0;
      this._playImpl = null;
      this.play = () => {
        this.playCalls += 1;
        if (this._playImpl) {
          return this._playImpl(this);
        }
        this.paused = false;
        this.dispatchEvent({ type: 'play' });
        return Promise.resolve();
      };
      this.pause = () => {
        this.pauseCalls += 1;
        this.paused = true;
        this.dispatchEvent({ type: 'pause' });
      };
    }
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] || null;
  }

  get previousSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i - 1] || null;
  }

  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) {
      this.childNodes.splice(i, 1);
      child.parentNode = null;
    }
    return child;
  }

  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const i = this.childNodes.indexOf(ref);
    child.parentNode = this;
    if (i >= 0) this.childNodes.splice(i, 0, child);
    else this.childNodes.push(child);
    return child;
  }

  contains(target) {
    if (!target) return false;
    if (target === this) return true;
    return this.childNodes.some((c) => c.contains && c.contains(target));
  }

  setAttribute(k, v) {
    const str = String(v);
    this.attributes[k] = str;
    if (k === 'class') this.className = str;
    if (k === 'id') this.id = str;
    if (k === 'src') this.src = str;
    if (k === 'type') this.type = str;
    if (k === 'value') this.value = str;
    if (k === 'placeholder') this.placeholder = str;
    if (k === 'title') this.title = str;
    if (k === 'disabled') this.disabled = true;
  }

  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, k)
      ? this.attributes[k]
      : null;
  }

  removeAttribute(k) {
    delete this.attributes[k];
    if (k === 'disabled') this.disabled = false;
  }

  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = new Set();
    this.listeners[type].add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners[type]?.delete(fn);
  }

  dispatchEvent(ev) {
    const eventObj = typeof ev === 'string' ? { type: ev } : ev;
    if (!eventObj.target) eventObj.target = this;
    eventObj.currentTarget = this;
    eventObj.preventDefault ||= () => {};
    eventObj.stopPropagation ||= () => {};
    const set = this.listeners[eventObj.type];
    if (set) {
      for (const fn of [...set]) {
        fn(eventObj);
      }
    }
    return true;
  }

  focus() {
    if (this.ownerDocument) {
      this.ownerDocument.activeElement = this;
    }
  }

  blur() {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }

  set textContent(v) {
    this.childNodes = [];
    if (v !== '' && v != null) {
      const t = new DOMNode(3, '#text', this.ownerDocument);
      t.nodeValue = String(v);
      this.appendChild(t);
    }
  }

  get textContent() {
    if (this.nodeType === 3) return this.nodeValue || '';
    return this.childNodes.map((c) => c.textContent).join('');
  }

  findAll(predicate, acc = []) {
    if (this.nodeType === 1 && predicate(this)) {
      acc.push(this);
    }
    for (const child of this.childNodes) {
      if (child.findAll) child.findAll(predicate, acc);
    }
    return acc;
  }

  find(predicate) {
    return this.findAll(predicate)[0] || null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const tag = selector.toUpperCase();
    return this.findAll((el) => el.tagName === tag);
  }
}

export function createTestDOM() {
  const doc = new DOMNode(9, '#document', null);
  doc.ownerDocument = doc;
  doc.documentElement = new DOMNode(1, 'HTML', doc);
  doc.body = new DOMNode(1, 'BODY', doc);
  doc.activeElement = doc.body;
  doc.documentElement.appendChild(doc.body);
  doc.title = 'TuneCloud';
  doc.createElement = (tag) => new DOMNode(1, String(tag).toUpperCase(), doc);
  doc.createElementNS = (ns, tag) => {
    const n = new DOMNode(1, String(tag).toUpperCase(), doc);
    n.namespaceURI = ns;
    return n;
  };
  doc.createTextNode = (t) => {
    const n = new DOMNode(3, '#text', doc);
    n.nodeValue = String(t);
    return n;
  };
  doc.createComment = (t) => {
    const n = new DOMNode(8, '#comment', doc);
    n.nodeValue = String(t);
    return n;
  };

  const storageMap = new Map();
  const localStorage = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
    clear: () => storageMap.clear(),
  };

  const windowListeners = {};
  const win = globalThis;
  doc.defaultView = win;

  const defineGlobal = (prop, value) => {
    Object.defineProperty(win, prop, {
      value,
      configurable: true,
      writable: true,
    });
  };

  defineGlobal('window', win);
  defineGlobal('document', doc);
  defineGlobal('localStorage', localStorage);
  defineGlobal('HTMLIFrameElement', class {});
  defineGlobal('Element', DOMNode);
  defineGlobal('HTMLElement', DOMNode);
  defineGlobal('Node', DOMNode);
  defineGlobal('innerWidth', 1280);
  defineGlobal('innerHeight', 800);
  defineGlobal('location', { origin: 'http://localhost:5173', href: 'http://localhost:5173/' });
  defineGlobal('navigator', {
    userAgent: 'node',
    clipboard: {
      writeText: async () => {},
    },
  });
  defineGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  win.addEventListener = (type, fn) => {
    if (!windowListeners[type]) windowListeners[type] = new Set();
    windowListeners[type].add(fn);
  };
  win.removeEventListener = (type, fn) => {
    windowListeners[type]?.delete(fn);
  };
  win.dispatchEvent = (ev) => {
    const set = windowListeners[ev.type];
    if (set) {
      for (const fn of [...set]) {
        fn(ev);
      }
    }
    return true;
  };

  return { document: doc, window: win, localStorage };
}

export function getReactProps(node) {
  if (!node) return {};
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps$'));
  return (key && node[key]) || {};
}

export async function render(element) {
  const container = globalThis.document.createElement('div');
  globalThis.document.body.appendChild(container);
  let root;
  await React.act(async () => {
    root = createRoot(container);
    root.render(element);
  });

  return {
    container,
    rerender: async (nextElement) => {
      await React.act(async () => {
        root.render(nextElement);
      });
    },
    unmount: async () => {
      await React.act(async () => {
        root.unmount();
      });
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      }
    },
  };
}

export async function click(node) {
  if (!node) throw new Error('click() called on null node');
  const props = getReactProps(node);
  if (props.disabled || node.disabled) return;
  await React.act(async () => {
    if (typeof props.onClick === 'function') {
      await props.onClick({
        target: node,
        currentTarget: node,
        preventDefault() {},
        stopPropagation() {},
      });
    }
  });
}

export async function changeInput(node, value) {
  if (!node) throw new Error('changeInput() called on null node');
  const props = getReactProps(node);
  await React.act(async () => {
    node.value = value;
    if (typeof props.onChange === 'function') {
      await props.onChange({
        target: { value },
        currentTarget: { value },
        preventDefault() {},
        stopPropagation() {},
      });
    }
  });
}

export async function focusInput(node) {
  if (!node) throw new Error('focusInput() called on null node');
  const props = getReactProps(node);
  await React.act(async () => {
    node.focus();
    if (typeof props.onFocus === 'function') {
      await props.onFocus({
        target: node,
        currentTarget: node,
        preventDefault() {},
        stopPropagation() {},
      });
    }
  });
}

export async function submitForm(node) {
  if (!node) throw new Error('submitForm() called on null node');
  const props = getReactProps(node);
  await React.act(async () => {
    if (typeof props.onSubmit === 'function') {
      await props.onSubmit({
        target: node,
        currentTarget: node,
        preventDefault() {},
        stopPropagation() {},
      });
    }
  });
}

export async function flushAsync(ms = 0) {
  await React.act(async () => {
    if (ms > 0) {
      await new Promise((r) => setTimeout(r, ms));
    } else {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

const origSetTimeout = globalThis.setTimeout.bind(globalThis);
globalThis.setTimeout = (fn, delay = 0, ...args) => {
  const handle = origSetTimeout(fn, delay, ...args);
  if (delay >= 1000 && handle && typeof handle.unref === 'function') {
    handle.unref();
  }
  return handle;
};

// Initialize default DOM environment on import
createTestDOM();
