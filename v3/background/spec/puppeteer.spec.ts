import * as puppeteer from 'puppeteer';
import * as path from 'path';
import * as http from 'http';

const extensionPath = path.join(__dirname, '../../../crx_test');

describe('Background Service Worker', () => {
    let browser: any = null;
    let backgroundWorker: any = null;
    beforeEach(async ()=>{
        jasmine.DEFAULT_TIMEOUT_INTERVAL = 99e3;
        browser = await puppeteer.launch({
            headless: false,
            pipe: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
            enableExtensions: [extensionPath],
            args: [
                '--no-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage'
            ]
        });
        const backgroundServiceWorkerTarget = await browser.waitForTarget(
          (target: any) => target.type() === 'service_worker'
            && target.url().endsWith('/background/out/background/src/background.js')
        );
        expect(backgroundServiceWorkerTarget).toBeTruthy();
        backgroundWorker = await backgroundServiceWorkerTarget.worker();
        backgroundWorker.on('console', (message: any) => {
            if (message.type() === 'error') {
                console.error(`Background service worker: ${message.text()}`);
            }
        });
    });
    const triggerExtension = async () => {
        await backgroundWorker.evaluate(async ()=>{
            const [tab] = await new Promise<chrome.tabs.Tab[]>(resolve => {
                chrome.tabs.query({active: true, currentWindow: true}, resolve);
            });
            // @ts-ignore Chrome's event dispatcher is exposed only to extension contexts.
            chrome.action.onClicked.dispatch(tab);
        });
        const target = await browser.waitForTarget(
            (target: any) => target.url().match('/ui/dist/ui/index.html')
        );
        expect(target).toBeTruthy();
        const page = await target.page();
        await new Promise(res=>page.once('load', res));
        return page;
    };
    it('does basic header modification', async ()=>{
        const server = http.createServer((req, res)=>{
            res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
            res.end(JSON.stringify({headers: req.headers, message: '中文响应'}));
        });
        let listening = new Promise(res=>server.once('listening', res));
        server.listen();
        await listening;
        expect(server.address()).toBeTruthy();
        // @ts-ignore http servers always return a port
        const port = server.address()!.port;
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/headers`);
        const extPage = await triggerExtension();
        await extPage.keyboard.type("/headers");
        await extPage.keyboard.press("Enter");
        await extPage.keyboard.press("Tab");
        await extPage.keyboard.press("Space");
        const reloadPromise = page.reload();
        const req = await extPage.waitForSelector('[apprequestlistitem]');
        await req.click();
        const reqHeaderInputs = await extPage.$$(
            '[apprequesteditorheaderitem] input[tabindex="0"]');
        expect(reqHeaderInputs.length).toBeGreaterThanOrEqual(2);
        await reqHeaderInputs[0].click({clickCount: 2});
        await extPage.keyboard.type("ModifiedReqHeaderName");
        await extPage.keyboard.press("Tab");
        await extPage.keyboard.type("ModifiedReqHeaderValue");
        const reqButton = await extPage.$(
            'app-request-editor mat-card-actions button');
        expect(reqButton).toBeTruthy();
        await reqButton.click();
        const resButton = await extPage.waitForSelector(
            'app-response-editor mat-card-actions button');
        expect(resButton).toBeTruthy();
        const responseBodyButton = await extPage.$('app-response-body button');
        expect(responseBodyButton).toBeTruthy();
        await responseBodyButton.click();
        const responseBody = await extPage.waitForSelector('app-response-body textarea');
        expect(await responseBody.evaluate((element: HTMLTextAreaElement) => element.value))
            .toContain('中文响应');
        await resButton.click();
        const reloadResponse = await reloadPromise;
        expect(reloadResponse.ok()).toBeTruthy();
        const response = await reloadResponse.json();
        expect(response.message).toBe('中文响应');
        expect(response.headers['modifiedreqheadername'])
            .toBe('ModifiedReqHeaderValue');
    });

    it('preserves a modified Chinese request body', async ()=>{
        const server = http.createServer((req, res)=>{
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(chunk));
            req.on('end', () => {
                res.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
                res.end(JSON.stringify({body: Buffer.concat(chunks).toString('utf8')}));
            });
        });
        const listening = new Promise(res=>server.once('listening', res));
        server.listen();
        await listening;
        // @ts-ignore http servers always return a port
        const port = server.address()!.port;
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/request-body`);
        const extPage = await triggerExtension();
        await extPage.keyboard.type('/request-body');
        await extPage.keyboard.press('Enter');
        await extPage.keyboard.press('Tab');
        await extPage.keyboard.press('Space');
        const responsePromise = page.evaluate(async (url: string) => {
            const response = await fetch(url, {method: 'POST', body: '原始请求'});
            return response.json();
        }, `http://127.0.0.1:${port}/request-body`);
        const request = await extPage.waitForSelector('[apprequestlistitem]');
        await request.click();
        const requestBody = await extPage.waitForSelector('app-request-body textarea');
        await requestBody.click({clickCount: 3});
        await requestBody.type('修改后的中文请求');
        const requestButton = await extPage.$('app-request-editor mat-card-actions button');
        expect(requestButton).toBeTruthy();
        await requestButton.click();
        const responseButton = await extPage.waitForSelector(
            'app-response-editor mat-card-actions button');
        expect(responseButton).toBeTruthy();
        await responseButton.click();
        expect((await responsePromise).body).toBe('修改后的中文请求');
    });
});
