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
            && target.url().startsWith('chrome-extension://')
        );
        expect(backgroundServiceWorkerTarget).toBeTruthy();
        backgroundWorker = await backgroundServiceWorkerTarget.worker();
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
            res.writeHead(200);
            res.end(JSON.stringify({headers: req.headers}));
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
        reqButton.click();
        const resButton = await extPage.waitForSelector(
            'app-response-editor mat-card-actions button');
        expect(resButton).toBeTruthy();
        const resHeaderInputs = await extPage.$$(
            '[appresponseeditorheaderitem] input[tabindex="0"]');
        expect(resHeaderInputs.length).toBeGreaterThanOrEqual(2);
        await resHeaderInputs[0].click({clickCount: 2});
        await extPage.keyboard.type("ModifiedResHeaderName");
        await extPage.keyboard.press("Tab");
        await extPage.keyboard.type("ModifiedResHeaderValue");
        resButton.click();
        const reloadResponse = await reloadPromise;
        expect(reloadResponse.ok()).toBeTruthy();
        expect(reloadResponse.headers()['modifiedresheadername'])
            .toBe('ModifiedResHeaderValue');
        const reqHeaders = await reloadResponse.json();
        expect(reqHeaders.headers['modifiedreqheadername'])
            .toBe('ModifiedReqHeaderValue');
    })
});
