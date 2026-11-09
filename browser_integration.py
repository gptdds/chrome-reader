"""Functional checks in the isolated Chrome test profile; never attaches to the user's profile."""
import asyncio
import json
import sys
import urllib.request
from pathlib import Path
import aiohttp

BASE = Path(__file__).resolve().parent
PORT = 'http://127.0.0.1:9222'
EXTENSION_ID = 'dalmdgpohkfpclknkcfpeifdminlijic'

async def targets():
    async with aiohttp.ClientSession() as client:
        async with client.get(PORT + '/json/list') as response:
            return await response.json()

async def evaluate(target, expression):
    async with aiohttp.ClientSession() as client:
        async with client.ws_connect(target['webSocketDebuggerUrl']) as ws:
            await ws.send_json({'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': expression, 'awaitPromise': True, 'returnByValue': True, 'userGesture': True}})
            async with asyncio.timeout(60):
                async for message in ws:
                    data = json.loads(message.data)
                    if data.get('id') == 1:
                        if data.get('error') or data.get('result', {}).get('exceptionDetails'):
                            raise RuntimeError(json.dumps(data, ensure_ascii=False))
                        return data['result']['result'].get('value')

async def wait_value(target, expression, timeout=20):
    async with asyncio.timeout(timeout):
        while True:
            result = await evaluate(target, expression)
            if result:
                return result
            await asyncio.sleep(0.15)

async def main():
    if sys.argv[1] == 'prepare':
        request = urllib.request.Request(PORT + '/json/new?http://127.0.0.1:18765/', method='PUT')
        page = json.load(urllib.request.urlopen(request, timeout=5))
        await wait_value(page, "document.querySelector('#status')?.textContent.includes('服务已连接')")
        fixture = '''<style>body{background:#f9fbff;color:#172338;font:24px/1.9 'Microsoft YaHei',sans-serif;margin:35px}article{width:480px;margin:0 auto}h1{font-size:29px}p{margin:24px 0}em{font-style:normal;color:#336699}</style><nav>导航噪声不应该被朗读</nav><article><h1>晓晓同步高亮测试</h1><p>春天来了，窗外的树叶轻轻摇动。<em>我们正在测试真实网页的自动换行</em>，语音读到哪里，文字就高亮到哪里。每一行都应该准确定位。</p><p>第二段用于检查段落高亮。按下暂停，高亮应当留在当前位置。切换两倍速以后，语音与高亮仍然同步。</p><p>第三段包含数字123和表情😀。切换按字高亮时，表情应当完整显示，不能被拆成两个字符。</p></article>'''
        await evaluate(page, 'document.title="晓晓功能验证"; document.body.innerHTML=' + json.dumps(fixture, ensure_ascii=False) + '; window.getSelection().removeAllRanges(); true')
        (BASE / 'browser-state.json').write_text(json.dumps({'pageId': page['id']}), encoding='utf-8')
        print('Fixture ready:', page['id'], flush=True)
        return
    entries = await targets()
    state = json.loads((BASE / 'browser-state.json').read_text())
    page = next(t for t in entries if t['id'] == state['pageId'])
    panel = next(t for t in entries if t['url'] == f'chrome-extension://{EXTENSION_ID}/reader.html')
    result = await wait_value(panel, "typeof audio !== 'undefined' && audio && !audio.paused && audio.currentTime > 0.05 && lastHighlight && ({time:audio.currentTime,source:!!source?.documentId,markers:lastHighlight.boundaries.length})", timeout=50)
    assert result['source'] and result['markers'] > 0, result
    print('Actual playback:', result, flush=True)
    result = await evaluate(panel, "document.querySelector('#pause').click(); ({paused:audio.paused,time:audio.currentTime})")
    assert result['paused'], result
    before = result['time']
    await asyncio.sleep(0.25)
    after = await evaluate(panel, 'audio.currentTime')
    assert abs(after - before) < .02, (before, after)
    speeds = []
    for speed in (1.25, 1.5, 2, 3):
        result = await evaluate(panel, f"document.querySelector('[data-speed=\"{speed}\"]').click(); ({{rate:audio.playbackRate,pitch:audio.preservesPitch}})")
        assert result == {'rate': speed, 'pitch': True}, result
        speeds.append(speed)
    print('Live speeds verified:', speeds, flush=True)
    await evaluate(panel, "const targetWord = lastHighlight.piece.text.indexOf('窗外'); const targetMarker = lastHighlight.boundaries.find(b=>b.startChar>=targetWord); audio.currentTime=targetMarker.start+targetMarker.duration*.2; true")
    highlights = {}
    for mode in ('character', 'line', 'paragraph'):
        await evaluate(panel, f"document.querySelector('#highlightMode').value='{mode}'; document.querySelector('#follow').checked=false; updateMode(); true")
        await asyncio.sleep(0.15)
        result = await evaluate(panel, "chrome.runtime.sendMessage({action:'highlightStatus',tabId:source.sourceTabId,documentId:source.documentId})")
        assert result and not result.get('error') and result.get('mode') == mode, result
        assert result.get('highlightRects'), result
        highlights[mode] = result
    c, l, p = (highlights[key] for key in ('character', 'line', 'paragraph'))
    assert c['end']-c['start'] in (1,2), c
    assert l['end']-l['start'] > c['end']-c['start'], (l,c)
    assert p['end']-p['start'] > l['end']-l['start'], (p,l)
    def extent(rects):
        return max(r['y']+r['height'] for r in rects)-min(r['y'] for r in rects)
    assert extent(p['highlightRects']) > extent(l['highlightRects']) * 1.5, highlights
    print('Highlight geometry verified:', {k:{'characters':v['end']-v['start'],'rects':len(v['highlightRects']),'height':round(extent(v['highlightRects']),1)} for k,v in highlights.items()}, flush=True)
    await evaluate(panel, "document.querySelector('#highlightMode').value='line'; updateMode(); setSpeed(1); true")
    await asyncio.sleep(.15)
    screenshot = await evaluate(page, "({title:document.title,cssHighlight:CSS.highlights.has('xiaoxiao-current')})")
    assert screenshot['cssHighlight'], screenshot
    await evaluate(panel, "document.querySelector('#stop').click(); true")
    result = await evaluate(panel, "chrome.runtime.sendMessage({action:'highlightStatus',tabId:source.sourceTabId,documentId:source.documentId})")
    assert not result.get('highlightRects'), result
    report = {'playback':True,'pause':True,'speeds':speeds,'highlights':{k:{'start':v['start'],'end':v['end'],'rects':v['highlightRects']} for k,v in highlights.items()},'stopClears':True}
    (BASE / 'browser-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Browser integration passed.', flush=True)

if __name__ == '__main__':
    asyncio.run(main())
