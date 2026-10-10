"""Step 2 of the held-out likeness test (step 1 is likeness.js): can a classifier tell the writer's real held-out words from
the engine's? A classifier two-sample test. AUC 0.5 means it cannot, 1.0 means it always can. Words are grouped by their text,
so the same word is never on both sides of the split, and both classes are drawn with the same pen at the same ink height, so
the pen itself cannot give anything away.

    python3 tools/likeness.py strokes.json [contact-sheet.png]

Needs numpy, pillow and scikit-learn. Prints, for letter words and for number words: the AUC of a few classifiers, two controls
(shuffled labels, and the real words split at random: both must sit near 0.5 or the test is broken), and the single numbers
about a word that differ most between real and generated. It says how detectable the engine's writing is, not how legible.
The picture shows each real word (top) with three renderings under it.
"""
import json
import sys

import numpy as np
from PIL import Image, ImageDraw
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

H, WMAX, SS = 40, 260, 4  # image height and widest width in pixels, supersampling


def bbox(strokes):
    xs = [p[0] for s in strokes for p in s]
    ys = [p[1] for s in strokes for p in s]
    return min(xs), min(ys), max(xs), max(ys)


def normalise(strokes):
    """Strokes scaled so the ink is 0.8 * H tall and moved to the origin."""
    x0, y0, x1, y1 = bbox(strokes)
    k = (H * 0.8) / max(y1 - y0, 1e-6)
    return [[((p[0] - x0) * k, (p[1] - y0) * k) for p in s] for s in strokes], (x1 - x0) * k, (y1 - y0) * k


def render(strokes, pen=0.07):
    ns, w, h = normalise(strokes)
    im = Image.new('L', (int(min(WMAX, max(8, w + 8))) * SS, H * SS), 0)
    d = ImageDraw.Draw(im)
    pw = max(1.0, pen * h * SS)
    for s in ns:
        pts = [(4 * SS + p[0] * SS, 0.1 * H * SS + p[1] * SS) for p in s]
        if len(pts) == 1:
            pts = pts * 2
        d.line(pts, fill=255, width=int(round(pw)), joint='curve')
        for q in (pts[0], pts[-1]):
            d.ellipse([q[0] - pw / 2, q[1] - pw / 2, q[0] + pw / 2, q[1] + pw / 2], fill=255)
    im = im.resize((im.width // SS, H), Image.LANCZOS)
    full = Image.new('L', (WMAX, H), 0)
    full.paste(im, (0, 0))
    return full


def resampled(ns, step=0.6):
    """Every stroke at a fixed step, so point density cannot matter."""
    out = []
    for s in ns:
        pts = [np.array(p) for p in s]
        res, acc = [pts[0]], 0.0
        for a, b in zip(pts, pts[1:]):
            d = np.linalg.norm(b - a)
            while acc + d >= step and d > 0:
                a = a + (b - a) * ((step - acc) / d)
                res.append(a)
                d = np.linalg.norm(b - a)
                acc = 0.0
            acc += d
        res.append(pts[-1])
        out.append(np.array(res))
    return out


NAMES = ['aspect', 'width_per_char', 'ink_fraction', 'strokes', 'strokes_per_char', 'length_per_char', 'slant', 'turn_mean',
         'turn_p90', 'gaps', 'gap_mean', 'gap_std', 'col_cv'] + ['row%d' % i for i in range(8)]


def features(it):
    """Numbers about a word. aspect: width over height; gaps*: white columns between letters (pixels); rowN: the share of ink in
    the Nth eighth of the picture from the top; turn*: how much the pen turns per step; slant: of the near-vertical strokes."""
    strokes = it['strokes']
    ns, w, h = normalise(strokes)
    n = max(len(it['text']), 1)
    segs = resampled(ns)
    length = sum(np.sum(np.linalg.norm(np.diff(s, axis=0), axis=1)) for s in segs if len(s) > 1)
    num = den = 0.0
    turn = []
    for s in segs:
        if len(s) < 3:
            continue
        d = np.diff(s, axis=0)
        dy = np.abs(d[:, 1])
        steep = dy > 0.5 * np.abs(d[:, 0])
        num += np.sum(-d[steep, 0] * np.sign(d[steep, 1]) * dy[steep])  # y is down, so leaning right is dx > 0 going up
        den += np.sum(dy[steep])
        turn.append(np.abs(np.diff(np.unwrap(np.arctan2(d[:, 1], d[:, 0])))))
    turn = np.concatenate(turn) if turn else np.zeros(1)
    img = np.asarray(render(strokes), dtype=np.float32) / 255.0
    ink = img.sum(axis=0) > 0.15
    cols = np.where(ink)[0]
    gaps, run = [], 0
    for c in (range(cols.min(), cols.max() + 1) if len(cols) else []):
        if not ink[c]:
            run += 1
        elif run:
            gaps.append(run)
            run = 0
    rows = img.sum(axis=1)
    rows = rows / max(rows.sum(), 1e-6)
    colp = img.sum(axis=0)[cols.min():cols.max() + 1] if len(cols) else np.ones(1)
    vals = [w / max(h, 1e-6), w / max(h, 1e-6) / n, float(img.mean()), len(strokes), len(strokes) / n, length / max(h, 1e-6) / n,
            num / den if den else 0.0, float(turn.mean()), float(np.percentile(turn, 90)), len(gaps),
            float(np.mean(gaps)) if gaps else 0.0, float(np.std(gaps)) if gaps else 0.0, float(colp.std() / max(colp.mean(), 1e-6))]
    vals += [rows[i * 5:(i + 1) * 5].sum() for i in range(8)]
    return np.array(vals), img


def cv_auc(X, y, groups, make, folds):
    """Grouped cross-validated AUC with the two classes weighted equally; also returns the out-of-fold scores."""
    X, y, groups = np.asarray(X), np.asarray(y), np.asarray(groups)
    score = np.zeros(len(y))
    for tr, te in GroupKFold(n_splits=folds).split(X, y, groups):
        m = make()
        w = np.where(y[tr] == 1, 0.5 / max((y[tr] == 1).sum(), 1), 0.5 / max((y[tr] == 0).sum(), 1)) * len(tr)
        last = m.steps[-1][0]
        m.fit(X[tr], y[tr], **{last + '__sample_weight': w})
        score[te] = m.predict_proba(X[te])[:, 1]
    return roc_auc_score(y, score), score


def logreg():
    return make_pipeline(StandardScaler(), LogisticRegression(C=0.3, max_iter=3000))


def gbm():
    return make_pipeline(HistGradientBoostingClassifier(max_iter=150, learning_rate=0.06, max_depth=3))


def report(kind, rows):
    sub = [r for r in rows if r[0]['kind'] == kind]
    y = np.array([1 if r[0]['label'] == 'gen' else 0 for r in sub])
    groups = np.array([r[0]['text'] for r in sub])
    F = np.array([r[1] for r in sub])
    if len(set(y)) < 2 or len(set(groups)) < 6:
        print('%s: not enough words' % kind)
        return
    folds = min(5, len(set(groups)))
    print('\n== %s: %d real, %d generated' % (kind, (y == 0).sum(), (y == 1).sum()))
    auc, oof = cv_auc(F, y, groups, logreg, folds)
    texts = np.array(sorted(set(groups)))
    rng = np.random.default_rng(3)
    boots = []
    for _ in range(300):
        pick = rng.choice(texts, size=len(texts), replace=True)
        idx = np.concatenate([np.where(groups == t)[0] for t in pick])
        if len(set(y[idx])) == 2:
            boots.append(roc_auc_score(y[idx], oof[idx]))
    print('AUC, logistic regression on word numbers: %.3f   (95%% range over word sets %.3f to %.3f)' % (auc, np.percentile(boots, 2.5), np.percentile(boots, 97.5)))
    print('AUC, gradient boosting on the same:       %.3f' % cv_auc(F, y, groups, gbm, folds)[0])
    ctrl = np.mean([cv_auc(F, rng.permutation(y), groups, logreg, folds)[0] for _ in range(5)])
    print('control, shuffled labels:                 %.3f   (should be near 0.5)' % ctrl)
    real = np.where(y == 0)[0]
    if len(real) >= 20:
        lab = np.zeros(len(y), dtype=int)
        lab[rng.permutation(real)[: len(real) // 2]] = 1
        print('control, real words split at random:      %.3f   (should be near 0.5)' % cv_auc(F[real], lab[real], groups[real], logreg, folds)[0])
    print('the numbers that differ most (real median, generated median, AUC of that number alone):')
    alone = sorted(((abs(roc_auc_score(y, F[:, j]) - 0.5), j) for j in range(F.shape[1])), reverse=True)[:6]
    for _, j in alone:
        print('  %-16s %8.3f %8.3f   %.2f' % (NAMES[j], np.median(F[y == 0, j]), np.median(F[y == 1, j]), roc_auc_score(y, F[:, j])))


def contact_sheet(rows, path, per=5, show=3):
    by = {}
    for it, _, img in rows:
        by.setdefault(it['text'], {}).setdefault(it['label'], []).append(img)
    texts = [t for t in sorted(by) if 'real' in by[t] and 'gen' in by[t]]
    rng = np.random.default_rng(7)
    chosen = list(rng.choice([t for t in texts if t.isalpha()], size=min(10, sum(t.isalpha() for t in texts)), replace=False))
    chosen += [t for t in texts if not t.isalpha()][:5]
    cw, ch = 190, H + 2
    sheet = Image.new('L', (per * cw, ((len(chosen) + per - 1) // per) * (show + 1) * ch + 14), 255)
    for k, t in enumerate(chosen):
        x, y = (k % per) * cw, (k // per) * (show + 1) * ch
        for r, img in enumerate(by[t]['real'][:1] + by[t]['gen'][:show]):
            tile = Image.fromarray(255 - np.clip(img * 255, 0, 255).astype(np.uint8)).crop((0, 0, cw - 6, H))
            sheet.paste(tile, (x + 3, y + r * ch))
    sheet.save(path)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    items = json.load(open(sys.argv[1]))['items']
    rows = []
    for it in items:
        f, img = features(it)
        rows.append((it, f, img))
    for kind in ('letters', 'digits'):
        report(kind, rows)
    if len(sys.argv) > 2:
        contact_sheet(rows, sys.argv[2])
        print('\ncontact sheet written to ' + sys.argv[2])
