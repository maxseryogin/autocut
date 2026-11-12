"""Check banner orientation in a real browser, including WebGL and CPU paths."""
import os
import unittest
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

EDGE = Path(os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)')) / 'Microsoft/Edge/Application/msedge.exe'


@unittest.skipUnless(sync_playwright and EDGE.is_file(), 'Playwright and Microsoft Edge required')
class ChromaOrientationTest(unittest.TestCase):
    def test_webgl_canvas_and_bitmap_match_cpu_orientation(self):
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=str(EDGE), headless=True,
                args=['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'],
            )
            try:
                page = browser.new_page()
                page.add_script_tag(path=str(Path(__file__).resolve().parents[1] / 'static' / 'chromakey.js'))
                result = page.evaluate('''async () => {
                    const source=document.createElement('canvas');source.width=8;source.height=8;
                    const ctx=source.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,8,4);ctx.fillStyle='blue';ctx.fillRect(0,4,8,4);
                    const bitmap=await createImageBitmap(source),gpu=SplitClipChroma.create();
                    if(!gpu)throw Error('WebGL unavailable');
                    const output=document.createElement('canvas');output.width=8;output.height=8;const out=output.getContext('2d');
                    function read(image,useGpu){out.clearRect(0,0,8,8);if(useGpu){gpu.render(image,50);out.drawImage(gpu.canvas,0,0)}else out.drawImage(image,0,0);return [Array.from(out.getImageData(4,1,1,1).data),Array.from(out.getImageData(4,6,1,1).data)]}
                    const result={canvas:read(source,true),bitmap:read(bitmap,true),cpu:read(bitmap,false),canvasAgain:read(source,true)};bitmap.close();return result;
                }''')
                expected = [[255, 0, 0, 255], [0, 0, 255, 255]]
                for value in result.values():
                    self.assertEqual(value, expected)
            finally:
                browser.close()


if __name__ == '__main__':
    unittest.main()
