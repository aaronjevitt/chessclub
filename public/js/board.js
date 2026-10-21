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
  constructor(container, { onMove, canMove } = {}) {
    this.container = container;
    this.onMove = onMove || (() => {});
    this.canMove = canMove || (() => true);
    this.orientation = 'white';
    this.chess = null;
    this.lastMove = null;
    this.selected = null;
    this.drag = null;
    this.annotations = { arrows: [], badges: [] };

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
    this.chess = chess;
    this.lastMove = lastMove;
    this.selected = null;
    this.render();
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
   * @param arrows [{from, to, color}]; badges [{square, symbol, color, title}]
   */
  setAnnotations({ arrows = [], badges = [] } = {}) {
    this.annotations = { arrows, badges };
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

  _targets(square) {
    return [...new Set(this.chess.moves({ square, verbose: true }).map((m) => m.to))];
  }

  _movable(square) {
    const piece = this.chess?.get(square);
    return piece && piece.color === this.chess.turn() && this.canMove(piece.color) && !this.chess.isGameOver();
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
    document.body.appendChild(ghost);
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
    if (to && to !== drag.from && this._targets(drag.from).includes(to)) this._attempt(drag.from, to);
  }

  _attempt(from, to) {
    const candidates = this.chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (!candidates.length) return;
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
