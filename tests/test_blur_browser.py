"""Exercise the blur editor and generated subtitle timing in a real browser."""
import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
    from werkzeug.serving import make_server
except ImportError:
    sync_playwright = None

EDGE = Path(os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)')) / 'Microsoft/Edge/Application/msedge.exe'


@unittest.skipUnless(sync_playwright and EDGE.is_file(), 'Playwright and Microsoft Edge required')
class BlurBrowserTest(unittest.TestCase):
    def test_editor_renders_timed_blur_and_lengthens_short_words(self):
        import app as server_app
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source = folder / 'fixture.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                            'testsrc2=size=180x320:rate=10', '-f', 'lavfi', '-i',
                            'sine=frequency=440:sample_rate=16000', '-t', '1', '-c:v',
                            'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
                            '-c:a', 'aac', str(source)], check=True)
            original_data = server_app.DATA
            server_app.DATA = folder
            server = make_server('127.0.0.1', 0, server_app.app, threaded=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(executable_path=str(EDGE), headless=True)
                    try:
                        page = browser.new_page(viewport={'width': 1280, 'height': 900})
                        errors = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.route('**/api/detect', lambda route: route.fulfill(json={
                            'x': 0, 'y': 0, 'width': 180, 'height': 320, 'confidence': 'full'}))
                        page.route('**/api/subtitles', lambda route: route.fulfill(json={'job_id': 'fake'}))
                        page.route('**/api/subtitles/*', lambda route: route.fulfill(json={
                            'state': 'done', 'message': 'Готово', 'segments': [
                                {'start': 0, 'end': .04, 'text': 'Я'},
                                {'start': .25, 'end': .29, 'text': 'в'},
                                {'start': .4, 'end': .9, 'text': 'сказал'}]}))
                        page.goto(f'http://127.0.0.1:{server.server_port}/')
                        self.assertFalse(page.locator('#blurDetails').get_attribute('open'))
                        page.locator('#sourceFile').set_input_files(str(source))
                        page.wait_for_function("document.querySelector('#sourceStatus').textContent.startsWith('Готово:')")
                        page.wait_for_function("document.querySelector('#subtitleCount').textContent.startsWith('3 ')")
                        timing = page.evaluate('subtitles.map(x=>({start:x.start,end:x.end}))')
                        self.assertGreaterEqual(timing[0]['end'] - timing[0]['start'], .299)
                        self.assertGreaterEqual(timing[1]['end'] - timing[1]['start'], .299)
                        self.assertEqual(timing[0]['end'], timing[1]['start'])
                        widths = page.locator('#subtitleTrackLane .subtitle-clip').evaluate_all('(items)=>items.map(item=>parseFloat(item.style.width))')
                        self.assertGreaterEqual(min(widths[:2]), 29.9, 'short words occupy their real duration on the track')
                        page.locator('#quality').select_option('720')
                        page.locator('#blurDetails > summary').click()
                        page.wait_for_function("document.querySelector('#blurCanvas').height>0 && document.querySelector('#source').readyState>=2")
                        page.locator('#blurStrength').fill('60')
                        page.locator('#blurFeather').fill('0')
                        page.evaluate('window.beforeBlur = document.querySelector("#canvas").getContext("2d").getImageData(0,0,720,1280).data')
                        page.locator('#blurCanvas').scroll_into_view_if_needed()
                        rect = page.locator('#blurCanvas').bounding_box()
                        page.mouse.move(rect['x'] + rect['width'] * .2, rect['y'] + rect['height'] * .2)
                        page.mouse.down()
                        page.mouse.move(rect['x'] + rect['width'] * .8, rect['y'] + rect['height'] * .8, steps=5)
                        page.mouse.up()
                        page.wait_for_function("document.querySelector('#blurCount').textContent==='1 обл.'")
                        page.wait_for_timeout(200)
                        difference = page.evaluate('''() => {
                          const after=document.querySelector('#canvas').getContext('2d').getImageData(0,0,720,1280).data;
                          let changed=0;for(let i=0;i<after.length;i+=16)if(Math.abs(after[i]-window.beforeBlur[i])>8)changed++;
                          return changed;
                        }''')
                        self.assertGreater(difference, 100, 'selected region changes preview pixels')
                        page.locator('#blurStart').fill('0.5')
                        page.locator('#blurStart').dispatch_event('change')
                        page.wait_for_timeout(100)
                        self.assertEqual(page.evaluate('blur.pixels(source,0)===source'), True, 'effect is inactive before its start')
                        self.assertEqual(page.evaluate('blur.pixels(source,.7)===source'), False, 'effect is active inside its interval')
                        export_difference = page.evaluate('''async () => {
                          const bitmap=await createImageBitmap(source);exportVisuals={source:bitmap};
                          exportSourceTime=.1;drawComposition();
                          const plain=ctx.getImageData(0,0,720,1280).data;
                          exportSourceTime=.7;drawComposition();
                          const blurred=ctx.getImageData(0,0,720,1280).data;
                          let changed=0;for(let i=0;i<plain.length;i+=16)if(Math.abs(plain[i]-blurred[i])>8)changed++;
                          exportVisuals=null;bitmap.close();return changed;
                        }''')
                        self.assertGreater(export_difference, 100, 'offline export composition uses the same timed effect')
                        page.evaluate("document.querySelector('#colorEnabled').checked=false")
                        page.wait_for_function("sourceAudio.state !== 'pending'", timeout=15000)
                        # Keep this end-to-end check light on the user's computer.
                        page.evaluate('canvas.width=180; canvas.height=320; ctx.setTransform(.25,0,0,.25,0,0)')
                        page.locator('#export').click()
                        page.wait_for_function("document.querySelector('#message').textContent.includes('Видео готово')", timeout=90000)
                        self.assertGreater(page.evaluate('lastExportBlob.size'), 1000, 'actual MP4 export completes with blur enabled')
                        page.locator('#blurTool').select_option('ellipse')
                        page.locator('#blurCanvas').scroll_into_view_if_needed()
                        rect = page.locator('#blurCanvas').bounding_box()
                        page.mouse.move(rect['x'] + rect['width'] * .1, rect['y'] + rect['height'] * .1)
                        page.mouse.down()
                        page.mouse.move(rect['x'] + rect['width'] * .3, rect['y'] + rect['height'] * .3, steps=5)
                        page.mouse.up()
                        self.assertEqual(page.locator('#blurCount').inner_text(), '2 обл.')
                        page.locator('#blurDelete').click()
                        page.locator('#blurDelete').click()
                        self.assertEqual(page.evaluate('blur.pixels(source,.7)===source'), True)
                        self.assertEqual(errors, [])
                    finally:
                        browser.close()
            finally:
                server.shutdown()
                thread.join(timeout=5)
                server_app.DATA = original_data


if __name__ == '__main__':
    unittest.main()
