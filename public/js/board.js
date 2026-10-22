// Interactive chessboard: click-to-move or drag-and-drop, legal-move hints, promotion picker.

const FILES = 'abcdefgh';
const PIECE_NAMES = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };

function squaresFor(orientation) {
  const out = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const file = orientation === 'white' ? col : 7 - col;
      const rank = orientation === 'white' ? 8 - row : row + 1;
      out.push(FILES[file] + rank);
    }
  }
  return out;
}

/** a1 is dark and h1 is light ("light on the right"). */
function isLight(square) {
  return (FILES.indexOf(square[0]) + Number(square[1])) % 2 === 0;
}

/** A piece drawn with the SVG artwork in /pieces (CSS class p-wK, p-bQ, ...). */
export function makePiece(piece) {
  const el = document.createElement('span');
  el.className = `piece p-${piece.color}${piece.type.toUpperCase()}`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `${piece.color === 'w' ? 'white' : 'black'} ${PIECE_NAMES[piece.type]}`);
  return el;
}

/**
 * Full-screen, clipped layer for the piece that follows your finger while dragging. Without it, the
 * dragged piece can poke past the screen edge (e.g. moving an h-file piece), which makes iOS Safari
 * re-zoom the page.
 */
function dragLayer() {
  let layer = document.getElementById('drag-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'drag-layer';
    document.body.appendChild(layer);
  }
  return layer;
}

/**
 * Read-only board for previews (club view, projector view).
 * @param opts.lastMove {from, to} squares to highlight; opts.check square of a king in check
 */
export function renderMiniBoard(fen, orientation = 'white', { lastMove = null, check = null } = {}) {
  const el = document.createElement('div');
  el.className = 'board mini';
  const placement = fen.split(' ')[0].split('/');
  const pieces = {};
  placement.forEach((row, i) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) file += Number(ch);
      else {
        pieces[FILES[file] + (8 - i)] = { type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? 'w' : 'b' };
        file++;
      }
    }
  });
  for (const sq of squaresFor(orientation)) {
    const cell = document.createElement('div');
    cell.className = `sq ${isLight(sq) ? 'light' : 'dark'}`;
    if (lastMove && (lastMove.from === sq || lastMove.to === sq)) cell.classList.add('last');
    if (check === sq) cell.classList.add('check');
    if (pieces[sq]) cell.appendChild(makePiece(pieces[sq]));
    el.appendChild(cell);
  }
  return el;
}

export class Board {
  /**
   * @param container element to render into
   * @param opts.onMove   (from, to, promotion) => void   called for a legal move by the user
   * @param opts.canMove  (color) => boolean               whether the user may move pieces of that color now
   */
  /**
   * @param opts.canPremove     (color) => boolean   whether the user may queue a move for that color now
   * @param opts.onPremove      (from, to, promotion) => void
   * @param opts.onPremoveCancel () => void          the user tapped elsewhere (cancel a queued move)
   */
  constructor(container, { onMove, canMove, canPremove, onPremove, onPremoveCancel } = {}) {
    this.container = container;
    this.onMove = onMove || (() => {});
    this.canMove = canMove || (() => true);
    this.canPremove = canPremove || (() => false);
    this.onPremove = onPremove || (() => {});
    this.onPremoveCancel = onPremoveCancel || (() => {});
    this.orientation = 'white';
    this.chess = null;
    this.lastMove = null;
    this.selected = null;
    this.drag = null;
    this.annotations = { arrows: [], badges: [], highlights: [] };
    // Pieces slide to their new squares when the position changes (0 = no animation).
    this.animationMs = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
    this.skipNextAnimation = false;

    this.el = document.createElement('div');
    this.el.className = 'board';
    container.innerHTML = '';
    container.appendChild(this.el);
    this.el.addEventListener('pointerdown', (e) => this._pointerDown(e));
    // Moves are made with pointer events, so the browser's own touch handling isn't needed on the board.
    // Cancelling every touch (start and end, as lichess's board does) stops the two quick taps of a move
    // — piece, then square — from triggering iOS Safari's double-tap zoom, even though the board redraws
    // between the taps. The promotion picker keeps its normal taps (it relies on click events).
    const cancelTouch = (e) => {
      if (!e.target.closest('.promotion')) e.preventDefault();
    };
    for (const type of ['touchstart', 'touchend', 'dblclick']) this.el.addEventListener(type, cancelTouch, { passive: false });
    this._onPointerMove = (e) => this._pointerMove(e);
    this._onPointerUp = (e) => this._pointerUp(e);
  }

  setPosition(chess, lastMove = null) {
    const before = this._pieceMap();
    this.chess = chess;
    this.lastMove = lastMove;
    this.selected = null;
    this.render();
    // A piece the user just dropped is already where it belongs; don't slide it again.
    if (this.skipNextAnimation) this.skipNextAnimation = false;
    else if (before && this.animationMs > 0) this._animate(before, this._pieceMap());
  }

  _pieceMap() {
    if (!this.chess) return null;
    const map = {};
    for (const row of this.chess.board()) for (const p of row) if (p) map[p.square] = p.color + p.type;
    return map;
  }

  /**
   * Slide pieces from their old squares to their new ones (handles normal moves, captures, castling and
   * promotion). Skipped for big jumps, where matching old and new squares would be guesswork.
   */
  _animate(before, after) {
    const appeared = Object.keys(after).filter((sq) => after[sq] !== before[sq]);
    const vanished = Object.keys(before).filter((sq) => before[sq] !== after[sq]);
    if (!appeared.length || appeared.length > 4) return;
    const coords = (sq) => [FILES.indexOf(sq[0]), Number(sq[1])];
    const pairs = [];
    for (const to of appeared) {
      const piece = after[to];
      const candidates = vanished.filter((sq) => before[sq] === piece || (before[sq] === piece[0] + 'p' && piece[1] !== 'p'));
      if (!candidates.length) continue;
      const [tf, tr] = coords(to);
      // Prefer an identical piece over a promoting pawn, then the nearest square.
      candidates.sort((a, b) => (before[a] === piece ? 0 : 1) - (before[b] === piece ? 0 : 1)
        || Math.hypot(coords(a)[0] - tf, coords(a)[1] - tr) - Math.hypot(coords(b)[0] - tf, coords(b)[1] - tr));
      const from = candidates[0];
      vanished.splice(vanished.indexOf(from), 1);
      pairs.push({ from, to });
    }
    const cell = (sq) => this.el.querySelector(`[data-square="${sq}"]`);
    const moving = [];
    for (const { from, to } of pairs) {
      const pieceEl = cell(to)?.querySelector('.piece');
      if (!pieceEl) continue;
      const dx = cell(from).offsetLeft - cell(to).offsetLeft;
      const dy = cell(from).offsetTop - cell(to).offsetTop;
      pieceEl.style.transition = 'none';
      pieceEl.style.transform = `translate(${dx}px, ${dy}px)`;
      pieceEl.classList.add('moving');
      moving.push(pieceEl);
    }
    if (!moving.length) return;
    void this.el.offsetWidth; // apply the starting offsets before transitioning back to place
    for (const pieceEl of moving) {
      pieceEl.style.transition = `transform ${this.animationMs}ms ease-out`;
      pieceEl.style.transform = '';
      pieceEl.addEventListener('transitionend', () => {
        pieceEl.classList.remove('moving');
        pieceEl.style.transition = '';
      }, { once: true });
    }
  }

  setOrientation(orientation) {
    this.orientation = orientation;
    this.render();
  }

  flip() {
    this.setOrientation(this.orientation === 'white' ? 'black' : 'white');
  }

  render() {
    if (!this.chess) return;
    this.el.innerHTML = '';
    this._closePromotion();
    const targets = this.selected ? this._targets(this.selected) : [];
    const checkSquare = this.chess.inCheck() ? this._kingSquare(this.chess.turn()) : null;
    const squares = squaresFor(this.orientation);
    squares.forEach((sq, i) => {
      const cell = document.createElement('div');
      cell.className = `sq ${isLight(sq) ? 'light' : 'dark'}`;
      cell.dataset.square = sq;
      if (this.lastMove && (this.lastMove.from === sq || this.lastMove.to === sq)) cell.classList.add('last');
      if (this.selected === sq) cell.classList.add('selected');
      if (checkSquare === sq) cell.classList.add('check');
      const piece = this.chess.get(sq);
      if (targets.includes(sq)) cell.classList.add(piece ? 'capture-target' : 'move-target');
      if (piece) cell.appendChild(makePiece(piece));
      if (i % 8 === 0) {
        const c = document.createElement('span');
        c.className = 'coord rank';
        c.textContent = sq[1];
        cell.appendChild(c);
      }
      if (i >= 56) {
        const c = document.createElement('span');
        c.className = 'coord file';
        c.textContent = sq[0];
        cell.appendChild(c);
      }
      const highlight = this.annotations.highlights.find((h) => h.square === sq);
      if (highlight) {
        cell.classList.add('highlighted');
        cell.style.setProperty('--highlight', highlight.color);
      }
      const badge = this.annotations.badges.find((b) => b.square === sq);
      if (badge) {
        const b = document.createElement('span');
        b.className = 'sq-badge';
        b.style.background = badge.color;
        b.textContent = badge.symbol;
        b.title = badge.title || '';
        cell.appendChild(b);
      }
      this.el.appendChild(cell);
    });
    if (this.annotations.arrows.length) this.el.appendChild(this._arrowLayer());
  }

  /**
   * Arrows and square badges drawn over the board (used by game review). Takes effect on the next render.
   * @param arrows [{from, to, color}]; badges [{square, symbol, color, title}]; highlights [{square, color}]
   */
  setAnnotations({ arrows = [], badges = [], highlights = [] } = {}) {
    this.annotations = { arrows, badges, highlights };
  }

  _arrowLayer() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'arrows');
    svg.setAttribute('viewBox', '0 0 800 800');
    const center = (sq) => {
      const f = FILES.indexOf(sq[0]);
      const r = Number(sq[1]);
      const col = this.orientation === 'white' ? f : 7 - f;
      const row = this.orientation === 'white' ? 8 - r : r - 1;
      return [col * 100 + 50, row * 100 + 50];
    };
    this.annotations.arrows.forEach(({ from, to, color }, i) => {
      const marker = document.createElementNS(NS, 'marker');
      marker.setAttribute('id', `arrowhead-${i}`);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '5');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '3.2');
      marker.setAttribute('markerHeight', '3.2');
      marker.setAttribute('orient', 'auto');
      const head = document.createElementNS(NS, 'path');
      head.setAttribute('d', 'M0,0 L10,5 L0,10 z');
      head.setAttribute('fill', color);
      marker.appendChild(head);
      svg.appendChild(marker);
      const [x1, y1] = center(from);
      const [x2, y2] = center(to);
      // Stop short of the target square's centre so the head sits on the square.
      const len = Math.hypot(x2 - x1, y2 - y1);
      const k = (len - 22) / len;
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x1 + (x2 - x1) * k);
      line.setAttribute('y2', y1 + (y2 - y1) * k);
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', '16');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('opacity', '0.85');
      line.setAttribute('marker-end', `url(#arrowhead-${i})`);
      svg.appendChild(line);
    });
    return svg;
  }

  _kingSquare(color) {
    for (const row of this.chess.board()) {
      for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
    }
    return null;
  }

  /** Is this a premove (a piece of the side not to move)? */
  _isPremove(square) {
    const piece = this.chess?.get(square);
    return !!piece && piece.color !== this.chess.turn();
  }

  /**
   * The position as if it were the other side's turn, for working out premove targets. It can't know
   * the opponent's coming move, so a premove is re-checked for legality when it is played.
   */
  _premoveChess() {
    const parts = this.chess.fen().split(' ');
    parts[1] = parts[1] === 'w' ? 'b' : 'w';
    parts[3] = '-';
    try {
      return new this.chess.constructor(parts.join(' '));
    } catch {
      return null;
    }
  }

  _movesFrom(square) {
    const chess = this._isPremove(square) ? this._premoveChess() : this.chess;
    return chess ? chess.moves({ square, verbose: true }) : [];
  }

  _targets(square) {
    return [...new Set(this._movesFrom(square).map((m) => m.to))];
  }

  _movable(square) {
    const piece = this.chess?.get(square);
    if (!piece || this.chess.isGameOver()) return false;
    return piece.color === this.chess.turn() ? this.canMove(piece.color) : this.canPremove(piece.color);
  }

  _squareAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el?.closest?.('.sq')?.dataset.square || null;
  }

  _pointerDown(e) {
    if (e.button !== 0 || !this.chess || this.promotionEl) return;
    const sq = e.target.closest('.sq')?.dataset.square;
    if (!sq) return;
    if (this.selected && this.selected !== sq && this._targets(this.selected).includes(sq)) {
      this._attempt(this.selected, sq);
      return;
    }
    if (!this._movable(sq)) {
      if (this.selected) {
        this.selected = null;
        this.render();
      } else {
        this.onPremoveCancel();
      }
      return;
    }
    e.preventDefault();
    const wasSelected = this.selected === sq;
    this.selected = sq;
    this.render();
    const pieceEl = this.el.querySelector(`[data-square="${sq}"] .piece`);
    const ghost = pieceEl.cloneNode(true);
    ghost.classList.add('ghost');
    const size = this.el.getBoundingClientRect().width / 8;
    ghost.style.width = ghost.style.height = `${size}px`;
    dragLayer().appendChild(ghost);
    this.drag = { from: sq, ghost, pieceEl, startX: e.clientX, startY: e.clientY, moved: false, wasSelected, size };
    this._positionGhost(e);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
  }

  _positionGhost(e) {
    const { ghost, size } = this.drag;
    ghost.style.left = `${e.clientX - size / 2}px`;
    ghost.style.top = `${e.clientY - size / 2}px`;
  }

  _pointerMove(e) {
    if (!this.drag) return;
    if (!this.drag.moved && Math.hypot(e.clientX - this.drag.startX, e.clientY - this.drag.startY) > 4) {
      this.drag.moved = true;
      this.drag.ghost.classList.add('visible');
      this.drag.pieceEl.classList.add('dragging');
    }
    if (this.drag.moved) this._positionGhost(e);
  }

  _pointerUp(e) {
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    drag.ghost.remove();
    drag.pieceEl.classList.remove('dragging');
    if (!drag.moved) {
      // A plain click on an already-selected piece deselects it.
      if (drag.wasSelected) {
        this.selected = null;
        this.render();
      }
      return;
    }
    const to = this._squareAt(e.clientX, e.clientY);
    if (to && to !== drag.from && this._targets(drag.from).includes(to)) {
      this.skipNextAnimation = true;
      this._attempt(drag.from, to);
    }
  }

  _attempt(from, to) {
    const candidates = this._movesFrom(from).filter((m) => m.to === to);
    if (!candidates.length) return;
    if (this._isPremove(from)) {
      // Premoves promote to a queen; there's no time to ask. Nothing moves yet, so nothing to skip.
      this.selected = null;
      this.skipNextAnimation = false;
      this.onPremove(from, to, candidates.some((m) => m.promotion) ? 'q' : undefined);
      return;
    }
    if (candidates.some((m) => m.promotion)) {
      this._askPromotion(to, this.chess.get(from).color).then((promotion) => {
        if (promotion) this._commit(from, to, promotion);
        else {
          this.selected = null;
          this.render();
        }
      });
      return;
    }
    this._commit(from, to);
  }

  _commit(from, to, promotion) {
    this.selected = null;
    this.onMove(from, to, promotion);
  }

  _askPromotion(square, color) {
    return new Promise((resolve) => {
      const picker = document.createElement('div');
      picker.className = 'promotion';
      for (const type of ['q', 'r', 'b', 'n']) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.appendChild(makePiece({ type, color }));
        btn.title = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[type];
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this._closePromotion();
          resolve(type);
        });
        picker.appendChild(btn);
      }
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'cancel';
      cancel.textContent = '✕';
      cancel.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._closePromotion();
        resolve(null);
      });
      picker.appendChild(cancel);
      this.promotionEl = picker;
      this.el.appendChild(picker);
      const cell = this.el.querySelector(`[data-square="${square}"]`);
      picker.style.left = `${cell.offsetLeft}px`;
      const fromTop = cell.offsetTop < this.el.clientHeight / 2;
      picker.style[fromTop ? 'top' : 'bottom'] = '0';
    });
  }

  _closePromotion() {
    this.promotionEl?.remove();
    this.promotionEl = null;
  }
}
