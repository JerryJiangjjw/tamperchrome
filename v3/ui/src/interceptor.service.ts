import { Injectable } from '@angular/core';
import { InterceptedData } from '../../common/types';

interface ExtensionPort {
  onMessage: { addListener(listener: (message: any) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: any): void;
}

declare const chrome: {
  runtime?: {
    connect(connectInfo: { name: string }): ExtensionPort;
  };
};

type RequestContinuation = (request: Partial<InterceptedData>) => void;
type ResponseContinuation = (response: Partial<InterceptedData>) => void;
type ResponseBodyReader = () => Promise<string>;

export class InterceptorRequest {
  method: string;
  readonly host: string;
  readonly path: string;
  readonly query: string;
  type: string;
  url: string;
  headers: Array<{name: string; value: string; disabled?: boolean}>;
  requestBody?: string;
  status?: number;
  responseHeaders: Array<{name: string; value: string; disabled?: boolean}>;
  responseBody?: string;
  pendingRequest = false;
  pendingResponse = false;
  hasResponse = false;
  hasResponseBody = false;
  visibleInFilter = false;
  cleared = false;
  private continueRequest?: RequestContinuation;
  private continueResponse?: ResponseContinuation;
  private responseBodyReader?: ResponseBodyReader;
  get pending(): boolean {
    return this.pendingRequest || this.pendingResponse;
  }
  get visible(): boolean {
    return !this.cleared && this.visibleInFilter;
  }

  constructor(private request: InterceptedData, continueRequest?: RequestContinuation) {
    this.method = request.method;
    this.url = request.url;
    this.headers = request.requestHeaders;
    this.requestBody = request.requestBody;
    const url = new URL(this.url);
    this.host = url.host;
    this.path = url.pathname;
    this.query = url.search;
    this.continueRequest = continueRequest;
    if (this.continueRequest) {
      this.pendingRequest = true;
    }
  }

  sendRequest() {
    if (this.continueRequest) {
      this.continueRequest({
        method: this.method,
        url: this.url,
        requestHeaders: this.headers.filter(v => !v.disabled),
        requestBody: this.requestBody,
      });
    }
    this.pendingRequest = false;
  }

  addResponse(
    request: InterceptedData,
    continueResponse: ResponseContinuation,
    responseBodyReader: ResponseBodyReader,
  ) {
    this.request = request;
    this.status = request.status;
    this.responseHeaders = request.responseHeaders;
    this.continueResponse = continueResponse;
    this.responseBodyReader = responseBodyReader;
    this.pendingResponse = true;
    this.hasResponse = true;
  }

  async getResponseBody() {
    if (typeof this.responseBody !== 'undefined') {
      return this.responseBody;
    }
    if (!this.responseBodyReader) {
      return this.responseBody = '';
    }
    this.responseBody = await this.responseBodyReader();
    this.hasResponseBody = true;
    return this.responseBody;
  }

  sendResponse() {
    if (this.continueResponse) {
      this.continueResponse({
        status: this.status,
        responseHeaders: this.responseHeaders.filter(v => !v.disabled),
        responseBody: this.responseBody
      });
    }
    this.pendingResponse = false;
  }
}

@Injectable({
  providedIn: 'root'
})
export class InterceptorService {
  enabled = false;
  filters: string[] = [];

  requests: InterceptorRequest[] = [];
  requestMap = new Map<string, InterceptorRequest>();
  changes;

  private extensionPort?: ExtensionPort;
  private responseBodyWaiters = new Map<string, Array<(body: string) => void>>();
  private waitForChange: Promise<void> = Promise.resolve();
  private triggerChange: (_: any) => void = null;

  constructor() {
    this.changes = this.getChanges();
  }

  startListening(window: Window) {
    if (typeof chrome !== 'undefined' && chrome.runtime?.connect) {
      this.startExtensionListening(window);
      return;
    }
    this.startWindowListening(window);
  }

  onRequest(request: InterceptedData, continueRequest?: RequestContinuation) {
    this.addRequest(request, continueRequest);
  }

  onResponse(
    response: InterceptedData,
    continueResponse: ResponseContinuation,
    responseBodyReader: ResponseBodyReader,
  ) {
    this.addResponse(response, continueResponse, responseBodyReader);
  }

  setFilters(filters: string[]) {
    this.filters = filters;
    this.filterRequests();
    this.triggerChange(0);
  }

  setInterceptEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  clearSent() {
    for (const request of this.requests) {
      request.cleared = !request.pending;
    }
  }

  reloadTab() {
    if (this.extensionPort) {
      this.extensionPort.postMessage({event: 'reloadTab'});
      return;
    }
    window.postMessage({event: 'reloadTab'}, '*');
  }

  private startWindowListening(window: Window) {
    window.addEventListener('message', e => {
      if (e.data.event === 'onRequest') {
        this.onRequest(e.data.request, request => e.ports[0].postMessage({request}));
      }
      if (e.data.event === 'onResponse') {
        this.onResponse(
          e.data.response,
          response => e.ports[0].postMessage({response}),
          () => new Promise(res => {
            e.ports[1].onmessage = body => res(body.data);
            e.ports[1].postMessage(null);
          }),
        );
      }
    });
    window.postMessage({event: 'capture', pattern: '*'}, '*');
  }

  private startExtensionListening(window: Window) {
    const tabId = Number(new URLSearchParams(window.location.search).get('tabId'));
    if (!Number.isInteger(tabId)) {
      console.error('Tamper Dev was opened without a tab id.');
      return;
    }

    const port = chrome.runtime.connect({name: 'tamper-dev'});
    this.extensionPort = port;
    port.onMessage.addListener(message => {
      if (message.event === 'onRequest') {
        this.onRequest(message.request, request => {
          port.postMessage({event: 'continueRequest', requestId: message.request.id, request});
        });
      }
      if (message.event === 'onResponse') {
        this.onResponse(
          message.response,
          response => {
            port.postMessage({event: 'continueResponse', requestId: message.response.id, response});
          },
          () => this.getExtensionResponseBody(port, message.response.id),
        );
      }
      if (message.event === 'responseBody') {
        this.resolveResponseBody(message.requestId, message.responseBody);
      }
    });
    port.onDisconnect.addListener(() => {
      if (this.extensionPort === port) {
        this.extensionPort = undefined;
        this.resolveAllResponseBodies();
      }
    });
    port.postMessage({event: 'connect', tabId});
    port.postMessage({event: 'capture', pattern: '*'});
  }

  private getExtensionResponseBody(port: ExtensionPort, requestId: string): Promise<string> {
    return new Promise(resolve => {
      const waiters = this.responseBodyWaiters.get(requestId) || [];
      waiters.push(resolve);
      this.responseBodyWaiters.set(requestId, waiters);
      try {
        port.postMessage({event: 'getResponseBody', requestId});
      } catch (error) {
        console.error('Failed to request intercepted response body', error);
        this.resolveResponseBody(requestId, '');
      }
    });
  }

  private resolveResponseBody(requestId: string, body: string) {
    const waiters = this.responseBodyWaiters.get(requestId) || [];
    this.responseBodyWaiters.delete(requestId);
    waiters.forEach(resolve => resolve(body));
  }

  private resolveAllResponseBodies() {
    for (const requestId of this.responseBodyWaiters.keys()) {
      this.resolveResponseBody(requestId, '');
    }
  }

  private async *getChanges() {
    while (true) {
      await this.waitForChange;
      this.waitForChange = new Promise(res => {
        this.triggerChange = res;
      });
      yield;
    }
  }

  private addRequest(request: InterceptedData, continueRequest?: RequestContinuation) {
    const intRequest = new InterceptorRequest(request, continueRequest);
    this.requestMap.set(request.id, intRequest);
    intRequest.visibleInFilter = this.filterRequest(intRequest);
    if (!this.enabled || !intRequest.visibleInFilter) {
      intRequest.sendRequest();
    }
    this.requests.push(intRequest);
    if (intRequest.visibleInFilter) {
      this.triggerChange(0);
    }
  }

  private addResponse(
    response: InterceptedData,
    continueResponse: ResponseContinuation,
    responseBodyReader: ResponseBodyReader,
  ) {
    if (!this.requestMap.has(response.id)) {
      this.addRequest(response);
    }
    const intRequest = this.requestMap.get(response.id);
    intRequest.addResponse(response, continueResponse, responseBodyReader);
    if (!this.enabled || !intRequest.visibleInFilter) {
      intRequest.sendResponse();
    }
    if (intRequest.visibleInFilter) {
      this.triggerChange(0);
    }
  }

  private filterRequests() {
    for (const request of this.requests) {
      request.visibleInFilter = this.filterRequest(request);
    }
  }

  private filterRequest(request: InterceptorRequest) {
    return this.filters.every(
      filter => Object.values(request).some(
        field => field === filter));
  }
}
