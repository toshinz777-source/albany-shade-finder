import asyncio, json
from playwright.async_api import async_playwright
async def main():
    out=[]
    async with async_playwright() as p:
        b=await p.chromium.launch(args=["--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"])
        ctx=await b.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
        await ctx.add_init_script("localStorage.setItem('helpShown','1')")
        pg=await ctx.new_page()
        pg.on('console',lambda m: out.append('CONSOLE '+m.type+' '+m.text))
        pg.on('pageerror',lambda e: out.append('PAGEERR '+str(e)))
        pg.on('requestfailed',lambda r: out.append(f'FAILED {r.method} {r.url[:140]} {r.failure} {r.headers.get("range")}'))
        def resp(r):
            if 'amazonaws' in r.url or 'overpass' in r.url: out.append(f'RESP {r.status} {r.url[:120]} {r.request.headers.get("range")}')
        pg.on('response',resp)
        def req(r):
            if 'amazonaws' in r.url: out.append(f'REQ {r.method} {r.url[:120]} {r.headers}')
        pg.on('request',req)
        await pg.goto('https://toshinz777-source.github.io/albany-shade-finder/')
        await pg.wait_for_timeout(25000)
        out.append('STATUS1 '+await pg.inner_text('#status'))
        await b.close()
    open('diag2.txt','w').write('\n'.join(out[:300]))
asyncio.run(main())
