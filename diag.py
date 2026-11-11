import asyncio, random
from playwright.async_api import async_playwright

async def main():
    out = []
    random.seed(1)
    aborted = [0]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        await ctx.add_init_script("localStorage.setItem('helpShown','1')")
        pg = await ctx.new_page()
        cdp = await ctx.new_cdp_session(pg)
        await cdp.send('Network.emulateNetworkConditions', {'offline': False, 'latency': 150, 'downloadThroughput': 1_000_000, 'uploadThroughput': 200_000})

        async def flaky(route):
            if random.random() < 0.25:
                aborted[0] += 1
                await route.abort('connectionreset')
            else:
                await route.continue_()
        await ctx.route('https://nz-elevation.s3.ap-southeast-2.amazonaws.com/**', flaky)
        pg.on('pageerror', lambda e: out.append('PAGEERR ' + str(e)))
        await pg.goto('https://toshinz777-source.github.io/albany-shade-finder/?v=2')
        for t in range(10):
            await pg.wait_for_timeout(5000)
            out.append(f't={5*(t+1)}s ' + await pg.inner_text('#status'))
        # move to Mairangi Bay shops (like the user) and zoom in
        await pg.evaluate("1")
        await pg.mouse.move(300, 500)
        await pg.mouse.down()
        await pg.mouse.move(60, 250, steps=10)
        await pg.mouse.up()
        for t in range(10):
            await pg.wait_for_timeout(5000)
            out.append(f'after-pan t={5*(t+1)}s ' + await pg.inner_text('#status'))
        await pg.screenshot(path='shot.png')
        out.append(f'aborted={aborted[0]}')
        await b.close()
    open('diag2.txt', 'w').write('\n'.join(out))

asyncio.run(main())
