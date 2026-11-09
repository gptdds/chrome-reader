"""Scoped CDP helper for the isolated Xiaoxiao test profile on port 9222."""
import asyncio
import json
import sys
from pathlib import Path
import urllib.request
import aiohttp

async def main():
    targets = json.load(urllib.request.urlopen('http://127.0.0.1:9222/json/list', timeout=3))
    if len(sys.argv) < 3:
        print(json.dumps([{k: t.get(k) for k in ('id','type','title','url')} for t in targets], ensure_ascii=False, indent=2))
        return
    target = next(t for t in targets if sys.argv[1] in t['url'] or sys.argv[1] == t['id'])
    argument = sys.argv[2]
    expression = Path(argument).read_text(encoding='utf-8') if argument.endswith('.js') else argument
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(target['webSocketDebuggerUrl']) as ws:
            await ws.send_json({'id': 1, 'method': 'Runtime.evaluate', 'params': {'expression': expression, 'awaitPromise': True, 'returnByValue': True, 'userGesture': True}})
            async with asyncio.timeout(60):
                async for message in ws:
                    data = json.loads(message.data)
                    if data.get('id') == 1:
                        print(json.dumps(data, ensure_ascii=False, indent=2))
                        return
asyncio.run(main())
