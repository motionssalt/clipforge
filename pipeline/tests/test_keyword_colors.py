"""Real raster-pixel and ASS regressions, not just metadata assertions."""
import tempfile
import unittest
from pathlib import Path
from pipeline.plan.keyword_colors import keyword_colors, color_warnings
from pipeline.stage_b import captions


class KeywordRegression(unittest.TestCase):
    def test_split_lowercase_punctuation_repeated_and_pixels(self):
        text = 'a victory, then more words before victory! at last'
        colors = keyword_colors({'voiceover_text': text, 'keywords': [{'word': 'VICTORY', 'color': '#F02040'}]})
        words = [{'word': w, 'start': i * .4, 'end': (i+1)*.4, 'keyword_color': colors.get(captions._norm_token(w))} for i, w in enumerate(text.split())]
        cards = captions.split_sentences(words)
        self.assertGreater(len(cards), 1)
        self.assertEqual(sum(w.get('keyword_color') == '#F02040' for c in cards for w in c['words']), 2)
        font = captions._caption_font(32)
        for card in cards:
            if not any(w.get('keyword_color') for w in card['words']):
                continue
            image = captions._raster_caption_layers(cards, {}, 640, 720, card['start'] + .01, font)
            self.assertTrue(any(r > 180 and g < 80 and b < 110 and a > 200 for r,g,b,a in image.getdata()))
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)/'test.ass'
            captions.write_cinematic_ass(cards, {}, 640, 720, str(path))
            ass = path.read_text()
            self.assertIn(r'\c&H4020F0&', ass)
            self.assertIn(r'\c&HFFFFFF&', ass)
            self.assertNotIn(r'\fad', ass)
            self.assertIn('victory,', ass)

    def test_legacy_and_specific_error(self):
        self.assertEqual(keyword_colors({'voiceover_text':'win!', 'keywords':{'WIN':{'color':'00ff00'}}}), {'win':'#00FF00'})
        with self.assertRaisesRegex(ValueError, r'cuts\[3\].*win.*invalid color'):
            keyword_colors({'voiceover_text':'win', 'keywords':[{'word':'win','color':'pink'}]}, 3)

    def test_no_colors_warn_without_failing(self):
        self.assertIn('Add keyword colors', color_warnings({'cuts':[{'voiceover_text':'plain white'}]})[0])


if __name__ == '__main__':
    unittest.main()
