import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from subtitles import _group_words

def word(start, end, text):
    return SimpleNamespace(start=start, end=end, word=text)

class SubtitleTests(unittest.TestCase):
    def test_groups_short_timed_phrases(self):
        segment = SimpleNamespace(words=[word(0, .3, ' Привет'), word(.31, .65, ' мир.'), word(1.5, 1.9, ' Дальше')], text='', start=0, end=2)
        captions = _group_words([segment])
        self.assertEqual([c['text'] for c in captions], ['Привет', 'мир.', 'Дальше'])
        self.assertEqual((captions[0]['start'], captions[0]['end']), (0, .3))
        self.assertEqual((captions[1]['start'], captions[1]['end']), (.31, .65))
        self.assertEqual((captions[2]['start'], captions[2]['end']), (1.5, 1.9))

    def test_segment_fallback_and_empty_words(self):
        segment = SimpleNamespace(words=[], text=' Текст ', start=2, end=3)
        self.assertEqual(_group_words([segment]), [{'start': 2, 'end': 3, 'text': 'Текст'}])
        silent = SimpleNamespace(words=[word(None, None, ' '), word(3, 4, '')], text='', start=3, end=4)
        self.assertEqual(_group_words([silent]), [])

    def test_missing_word_timestamps_still_splits_caption(self):
        segment = SimpleNamespace(words=[], text='два слова', start=4, end=6)
        self.assertEqual(_group_words([segment]), [{'start': 4.0, 'end': 5.0, 'text': 'два'}, {'start': 5.0, 'end': 6.0, 'text': 'слова'}])

if __name__ == '__main__': unittest.main()
