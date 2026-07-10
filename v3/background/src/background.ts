import { Debuggee } from './debuggee.js';
import { Interception } from './interception.js';
import { Intercepted } from './request.js';
import type { InterceptedData } from '../../common/types';

const PORT_NAME = 'tamper-dev';
const action: { onClicked: { addListener(listener: (tab: chrome.tabs.Tab) => void): void } } =
  (chrome as any).action;

interface Session {
  tabId: number;
  debuggee: Debuggee;
  interception: Interception;
  pending: Map<string, Intercepted>;
  captured: boolean;
  closed: boolean;
  popupWindowId?: number;
  port?: chrome.runtime.Port;
}

const sessions = new Map<number, Session>();

action.onClicked.addListener(tab => {
  void startSession(tab);
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== PORT_NAME) {
    return;
  }

  let session: Session | undefined;
  port.onMessage.addListener(message => {
    if (message.event === 'connect') {
      if (session) {
        return;
      }
      const tabId = Number(message.tabId);
      const candidate = sessions.get(tabId);
      if (!Number.isInteger(tabId) || !candidate || candidate.closed) {
        port.disconnect();
        return;
      }
      session = candidate;
      if (session.port && session.port !== port) {
        session.port.disconnect();
      }
      session.port = port;
      return;
    }

    if (session) {
      void handleUiMessage(session, message);
    }
  });

  port.onDisconnect.addListener(() => {
    if (session && session.port === port) {
      void closeSession(session);
    }
  });
});

chrome.windows.onRemoved.addListener(windowId => {
  for (const session of sessions.values()) {
    if (session.popupWindowId === windowId) {
      void closeSession(session);
      return;
    }
  }
});

async function startSession(tab: chrome.tabs.Tab) {
  if (tab.id === undefined) {
    return;
  }

  const existing = sessions.get(tab.id);
  if (existing) {
    if (existing.popupWindowId !== undefined) {
      chrome.windows.update(existing.popupWindowId, { focused: true });
    }
    return;
  }

  const debuggee = new Debuggee(tab);
  try {
    await debuggee.attach();
  } catch (error) {
    console.error('Failed to attach debugger', error);
    return;
  }

  const session: Session = {
    tabId: tab.id,
    debuggee,
    interception: Interception.build(debuggee),
    pending: new Map(),
    captured: false,
    closed: false,
  };
  sessions.set(tab.id, session);

  await session.interception.onRequest(request => {
    void reportPausedRequest(session, request, 'onRequest');
  });
  await session.interception.onResponse(response => {
    void reportPausedRequest(session, response, 'onResponse');
  });
  void debuggee.waitForDetach().then(() => closeSession(session, false, true));

  const popupUrl = new URL(chrome.runtime.getURL('ui/dist/ui/index.html'));
  popupUrl.searchParams.set('tabId', String(tab.id));
  try {
    const popup = await createPopup(popupUrl.toString());
    session.popupWindowId = popup.id;
  } catch (error) {
    console.error('Failed to open the Tamper Dev window', error);
    await closeSession(session);
  }
}

function createPopup(url: string): Promise<chrome.windows.Window> {
  return new Promise((resolve, reject) => {
    chrome.windows.create({ url, type: 'popup', width: 900, height: 800 }, popup => {
      if (chrome.runtime.lastError || !popup) {
        reject(chrome.runtime.lastError || new Error('Chrome did not create a window'));
        return;
      }
      resolve(popup);
    });
  });
}

async function handleUiMessage(session: Session, message: any) {
  if (session.closed) {
    return;
  }

  if (message.event === 'capture') {
    if (!session.captured) {
      await session.interception.capture(message.pattern || '*');
      session.captured = true;
    }
    return;
  }

  if (message.event === 'reloadTab') {
    chrome.tabs.reload(session.tabId, { bypassCache: true });
    return;
  }

  const intercepted = session.pending.get(message.requestId);
  if (!intercepted) {
    return;
  }

  if (message.event === 'continueRequest') {
    try {
      await intercepted.continueRequest(message.request || {});
    } finally {
      session.pending.delete(message.requestId);
    }
    return;
  }

  if (message.event === 'continueResponse') {
    try {
      await intercepted.continueResponse(message.response || {});
    } finally {
      session.pending.delete(message.requestId);
    }
    return;
  }

  if (message.event === 'getResponseBody') {
    try {
      session.port?.postMessage({
        event: 'responseBody',
        requestId: message.requestId,
        responseBody: await intercepted.getResponseBody(),
      });
    } catch (error) {
      console.error('Failed to read intercepted response body', error);
      session.port?.postMessage({
        event: 'responseBody',
        requestId: message.requestId,
        responseBody: '',
      });
    }
  }
}

async function reportPausedRequest(session: Session, intercepted: Intercepted, event: 'onRequest' | 'onResponse') {
  if (session.closed || !session.port) {
    if (event === 'onRequest') {
      await intercepted.continueRequest({});
    } else {
      await intercepted.continueResponse({});
    }
    return;
  }

  session.pending.set(intercepted.id, intercepted);
  session.port.postMessage({
    event,
    [event === 'onRequest' ? 'request' : 'response']: serialize(intercepted),
  });
}

function serialize(intercepted: Intercepted): InterceptedData {
  return JSON.parse(JSON.stringify(intercepted));
}

async function closeSession(session: Session, detach = true, removePopup = false) {
  if (session.closed) {
    return;
  }
  session.closed = true;
  sessions.delete(session.tabId);

  const popupWindowId = session.popupWindowId;
  session.popupWindowId = undefined;
  if (session.port) {
    session.port.disconnect();
    session.port = undefined;
  }

  if (detach && !session.debuggee.dead) {
    try {
      await session.debuggee.detach();
    } catch (error) {
      console.error('Failed to detach debugger', error);
    }
  }

  if (removePopup && popupWindowId !== undefined) {
    chrome.windows.remove(popupWindowId);
  }
}
