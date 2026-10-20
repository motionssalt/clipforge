"""Literal, per-cut keyword colors. Legacy list and dictionary forms accepted."""
import re
import unicodedata

NO_COLORS_WARNING = 'No colored caption keywords. Paste to your AI: Add keyword colors: include cuts[].keywords with a few meaningful words per line and literal #RRGGBB colors; leave all other words white.'


def normalize_word(word):
    return ''.join(c for c in unicodedata.normalize('NFKC', str(word)).casefold() if c.isalnum())


def keyword_colors(cut, index=0):
    raw = cut.get('keywords', [])
    if isinstance(raw, dict):
        raw = [{'word': w, 'color': v.get('color') if isinstance(v, dict) else v} for w, v in raw.items()]
    if not isinstance(raw, list):
        raise ValueError(f'cuts[{index}].keywords must be a list or legacy word/color dictionary.')
    result = {}
    text_words = {normalize_word(w) for w in str(cut.get('voiceover_text') or cut.get('raw_narration') or '').split()}
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError(f'cuts[{index}].keywords entry must contain word and color.')
        word = normalize_word(item.get('word', ''))
        color = item.get('color')
        if not word or word not in text_words:
            raise ValueError(f'cuts[{index}] keyword {item.get("word")!r} does not match a word in voiceover_text (case/punctuation ignored).')
        if not isinstance(color, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', color.strip()):
            raise ValueError(f'cuts[{index}] keyword {item.get("word")!r}: invalid color {color!r}; use literal #RRGGBB.')
        result[word] = color.strip().upper()
    return result


def color_warnings(plan):
    cuts = plan.get('cuts') or plan.get('segments') or []
    return [] if any(keyword_colors(c, i) for i, c in enumerate(cuts)) else [NO_COLORS_WARNING]
