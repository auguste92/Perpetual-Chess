"use strict";

/* ---------- constants ---------- */

/* Minimalist piece symbols: king=crown, queen=star, rook=tower,
   bishop=triangle, knight=hook, pawn=circle. White pieces render as a
   hollow outline, black pieces as a solid fill, both in plain white. */
const PIECE_PATHS = {
  k: "M4,19 L4,10 L8,14 L12,6 L16,14 L20,10 L20,19 Z",
  q: "M12,17.27 L18.18,21 L16.54,13.97 L22,9.24 L14.81,8.63 L12,2 L9.19,8.63 L2,9.24 L7.46,13.97 L5.82,21 Z",
  r: "M3,19 L3,5 L7,5 L7,8 L10,8 L10,5 L14,5 L14,8 L17,8 L17,5 L21,5 L21,19 Z",
  b: "M12,5 L18,20 L6,20 Z",
  n: "M6,20 L6,10 L10,10 L10,6 L20,6 L20,12 L14,12 L14,20 Z",
};

const KNIGHT_DELTAS = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2],
  [1, -2], [1, 2], [2, -1], [2, 1],
];
const KING_DELTAS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];
const BISHOP_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ROOK_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

const HUMAN_COLOR = "w";
const AI_COLOR = "b";
const AI_MOVE_DELAY = 350; // ms, lets the player's move render before the AI "thinks"

// Difficulty adapts to recent results: a win steps the AI up a tier,
// a loss steps it back down, so it settles near whatever level the
// player can actually challenge instead of only ever getting harder.
const DIFFICULTY_TIERS = [
  { depth: 3, optimal: false }, // 0: shallow search, sometimes plays a weaker tied move
  { depth: 3, optimal: true },  // 1: same depth, but always plays its best move
  { depth: 4, optimal: true },  // 2: looks one ply further ahead
  { depth: 5, optimal: true },  // 3: hardest tier
];
const MAX_DIFFICULTY = DIFFICULTY_TIERS.length - 1;

/* ---------- state ---------- */

let state = null;
let selected = null; // {r,c}
let legalForSelected = [];
let inputLocked = false; // true while the AI is computing a move

/* ---------- setup ---------- */

function initialBoard() {
  const b = Array.from({ length: 8 }, () => Array(8).fill(null));
  const backRank = ["r", "n", "b", "q", "k", "b", "n", "r"];
  for (let c = 0; c < 8; c++) {
    b[0][c] = { type: backRank[c], color: "b" };
    b[1][c] = { type: "p", color: "b" };
    b[6][c] = { type: "p", color: "w" };
    b[7][c] = { type: backRank[c], color: "w" };
  }
  return b;
}

function newGameState() {
  return {
    board: initialBoard(),
    turn: "w",
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    enPassant: null, // {r,c} square that can be captured onto
    status: "playing", // playing | check | checkmate | stalemate
  };
}

/* ---------- helpers ---------- */

function inside(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function cloneState(s) {
  return {
    board: s.board.map((row) => row.map((p) => (p ? { ...p } : null))),
    turn: s.turn,
    castling: { ...s.castling },
    enPassant: s.enPassant ? { ...s.enPassant } : null,
    status: s.status,
  };
}

function opponent(color) {
  return color === "w" ? "b" : "w";
}

/* ---------- raw movement patterns (ignore turn legality) ---------- */

function rawSlides(board, r, c, dirs) {
  const squares = [];
  for (const [dr, dc] of dirs) {
    let nr = r + dr, nc = c + dc;
    while (inside(nr, nc)) {
      squares.push({ r: nr, c: nc });
      if (board[nr][nc]) break; // stop at first occupant (inclusive)
      nr += dr; nc += dc;
    }
  }
  return squares;
}

function rawSteps(r, c, deltas) {
  const squares = [];
  for (const [dr, dc] of deltas) {
    const nr = r + dr, nc = c + dc;
    if (inside(nr, nc)) squares.push({ r: nr, c: nc });
  }
  return squares;
}

function pawnAttackSquares(r, c, color) {
  const dir = color === "w" ? -1 : 1;
  return [{ r: r + dir, c: c - 1 }, { r: r + dir, c: c + 1 }].filter((s) => inside(s.r, s.c));
}

/* squares a piece attacks (used for check detection); pawns = diagonals only */
function attackSquaresFor(board, r, c) {
  const piece = board[r][c];
  if (!piece) return [];
  switch (piece.type) {
    case "p": return pawnAttackSquares(r, c, piece.color);
    case "n": return rawSteps(r, c, KNIGHT_DELTAS);
    case "k": return rawSteps(r, c, KING_DELTAS);
    case "b": return rawSlides(board, r, c, BISHOP_DIRS);
    case "r": return rawSlides(board, r, c, ROOK_DIRS);
    case "q": return rawSlides(board, r, c, [...BISHOP_DIRS, ...ROOK_DIRS]);
    default: return [];
  }
}

function isSquareAttacked(board, r, c, byColor) {
  for (let rr = 0; rr < 8; rr++) {
    for (let cc = 0; cc < 8; cc++) {
      const p = board[rr][cc];
      if (p && p.color === byColor) {
        const atks = attackSquaresFor(board, rr, cc);
        if (atks.some((s) => s.r === r && s.c === c)) return true;
      }
    }
  }
  return false;
}

function findKing(board, color) {
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r][c] && board[r][c].type === "k" && board[r][c].color === color) return { r, c };
  return null;
}

/* ---------- pseudo-legal move generation ---------- */

function pseudoMovesForPiece(s, r, c) {
  const board = s.board;
  const piece = board[r][c];
  if (!piece) return [];
  const moves = [];

  if (piece.type === "p") {
    const dir = piece.color === "w" ? -1 : 1;
    const startRow = piece.color === "w" ? 6 : 1;
    const lastRow = piece.color === "w" ? 0 : 7;

    if (inside(r + dir, c) && !board[r + dir][c]) {
      moves.push({ to: { r: r + dir, c }, promotion: r + dir === lastRow });
      if (r === startRow && !board[r + 2 * dir][c]) {
        moves.push({ to: { r: r + 2 * dir, c }, doubleStep: true });
      }
    }
    for (const s2 of pawnAttackSquares(r, c, piece.color)) {
      const target = board[s2.r][s2.c];
      if (target && target.color !== piece.color) {
        moves.push({ to: s2, capture: true, promotion: s2.r === lastRow });
      } else if (s.enPassant && s.enPassant.r === s2.r && s.enPassant.c === s2.c) {
        moves.push({ to: s2, capture: true, enPassant: true });
      }
    }
  } else if (piece.type === "n" || piece.type === "k") {
    const deltas = piece.type === "n" ? KNIGHT_DELTAS : KING_DELTAS;
    for (const sq of rawSteps(r, c, deltas)) {
      const target = board[sq.r][sq.c];
      if (!target || target.color !== piece.color) {
        moves.push({ to: sq, capture: !!target });
      }
    }
  } else {
    const dirs = piece.type === "b" ? BISHOP_DIRS : piece.type === "r" ? ROOK_DIRS : [...BISHOP_DIRS, ...ROOK_DIRS];
    for (const sq of rawSlides(board, r, c, dirs)) {
      const target = board[sq.r][sq.c];
      if (!target) moves.push({ to: sq });
      else if (target.color !== piece.color) moves.push({ to: sq, capture: true });
    }
  }

  if (piece.type === "k") {
    const row = piece.color === "w" ? 7 : 0;
    if (r === row && c === 4) {
      const rights = s.castling;
      const oppo = opponent(piece.color);
      const kingSideRight = piece.color === "w" ? rights.wK : rights.bK;
      const queenSideRight = piece.color === "w" ? rights.wQ : rights.bQ;
      const inCheckNow = isSquareAttacked(board, row, 4, oppo);

      if (kingSideRight && !inCheckNow && !board[row][5] && !board[row][6] &&
          board[row][7] && board[row][7].type === "r" && board[row][7].color === piece.color &&
          !isSquareAttacked(board, row, 5, oppo) && !isSquareAttacked(board, row, 6, oppo)) {
        moves.push({ to: { r: row, c: 6 }, castle: "K" });
      }
      if (queenSideRight && !inCheckNow && !board[row][3] && !board[row][2] && !board[row][1] &&
          board[row][0] && board[row][0].type === "r" && board[row][0].color === piece.color &&
          !isSquareAttacked(board, row, 3, oppo) && !isSquareAttacked(board, row, 2, oppo)) {
        moves.push({ to: { r: row, c: 2 }, castle: "Q" });
      }
    }
  }

  return moves.map((m) => ({ from: { r, c }, ...m }));
}

/* ---------- apply a move (mutates given state; promotions always become queens) ---------- */

function applyMove(s, move) {
  const board = s.board;
  const { from, to } = move;
  const piece = board[from.r][from.c];
  const color = piece.color;
  let captured = move.capture ? board[to.r][to.c] : null;

  if (move.enPassant) {
    const capR = color === "w" ? to.r + 1 : to.r - 1;
    captured = board[capR][to.c];
    board[capR][to.c] = null;
  }

  board[from.r][from.c] = null;
  board[to.r][to.c] = { type: piece.type, color };

  if (move.promotion) {
    board[to.r][to.c] = { type: "q", color };
  }

  if (move.castle === "K") {
    const row = to.r;
    board[row][5] = board[row][7];
    board[row][7] = null;
  } else if (move.castle === "Q") {
    const row = to.r;
    board[row][3] = board[row][0];
    board[row][0] = null;
  }

  if (piece.type === "k") {
    if (color === "w") { s.castling.wK = false; s.castling.wQ = false; }
    else { s.castling.bK = false; s.castling.bQ = false; }
  }
  if (piece.type === "r") {
    if (color === "w" && from.r === 7 && from.c === 0) s.castling.wQ = false;
    if (color === "w" && from.r === 7 && from.c === 7) s.castling.wK = false;
    if (color === "b" && from.r === 0 && from.c === 0) s.castling.bQ = false;
    if (color === "b" && from.r === 0 && from.c === 7) s.castling.bK = false;
  }
  if (captured && captured.type === "r") {
    if (to.r === 7 && to.c === 0) s.castling.wQ = false;
    if (to.r === 7 && to.c === 7) s.castling.wK = false;
    if (to.r === 0 && to.c === 0) s.castling.bQ = false;
    if (to.r === 0 && to.c === 7) s.castling.bK = false;
  }

  s.enPassant = move.doubleStep ? { r: (from.r + to.r) / 2, c: from.c } : null;
  s.turn = opponent(color);

  return captured;
}

/* ---------- legality filtering ---------- */

function isKingInCheck(s, color) {
  const kingPos = findKing(s.board, color);
  if (!kingPos) return false;
  return isSquareAttacked(s.board, kingPos.r, kingPos.c, opponent(color));
}

function legalMovesForPiece(s, r, c) {
  const piece = s.board[r][c];
  if (!piece) return [];
  const pseudo = pseudoMovesForPiece(s, r, c);
  return pseudo.filter((m) => {
    const clone = cloneState(s);
    applyMove(clone, m);
    return !isKingInCheck(clone, piece.color);
  });
}

function allLegalMoves(s, color) {
  const all = [];
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      const p = s.board[r][c];
      if (p && p.color === color) all.push(...legalMovesForPiece(s, r, c));
    }
  return all;
}

/* ---------- AI: minimax with alpha-beta pruning ---------- */

const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

const PST = {
  p: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [50, 50, 50, 50, 50, 50, 50, 50],
    [10, 10, 20, 30, 30, 20, 10, 10],
    [5, 5, 10, 25, 25, 10, 5, 5],
    [0, 0, 0, 20, 20, 0, 0, 0],
    [5, -5, -10, 0, 0, -10, -5, 5],
    [5, 10, 10, -20, -20, 10, 10, 5],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ],
  n: [
    [-50, -40, -30, -30, -30, -30, -40, -50],
    [-40, -20, 0, 0, 0, 0, -20, -40],
    [-30, 0, 10, 15, 15, 10, 0, -30],
    [-30, 5, 15, 20, 20, 15, 5, -30],
    [-30, 0, 15, 20, 20, 15, 0, -30],
    [-30, 5, 10, 15, 15, 10, 5, -30],
    [-40, -20, 0, 5, 5, 0, -20, -40],
    [-50, -40, -30, -30, -30, -30, -40, -50],
  ],
  b: [
    [-20, -10, -10, -10, -10, -10, -10, -20],
    [-10, 0, 0, 0, 0, 0, 0, -10],
    [-10, 0, 5, 10, 10, 5, 0, -10],
    [-10, 5, 5, 10, 10, 5, 5, -10],
    [-10, 0, 10, 10, 10, 10, 0, -10],
    [-10, 10, 10, 10, 10, 10, 10, -10],
    [-10, 5, 0, 0, 0, 0, 5, -10],
    [-20, -10, -10, -10, -10, -10, -10, -20],
  ],
  r: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [5, 10, 10, 10, 10, 10, 10, 5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [0, 0, 0, 5, 5, 0, 0, 0],
  ],
  q: [
    [-20, -10, -10, -5, -5, -10, -10, -20],
    [-10, 0, 0, 0, 0, 0, 0, -10],
    [-10, 0, 5, 5, 5, 5, 0, -10],
    [-5, 0, 5, 5, 5, 5, 0, -5],
    [0, 0, 5, 5, 5, 5, 0, -5],
    [-10, 5, 5, 5, 5, 5, 0, -10],
    [-10, 0, 5, 0, 0, 0, 0, -10],
    [-20, -10, -10, -5, -5, -10, -10, -20],
  ],
  k: [
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-20, -30, -30, -40, -40, -30, -30, -20],
    [-10, -20, -20, -20, -20, -20, -20, -10],
    [20, 20, 0, 0, 0, 0, 20, 20],
    [20, 30, 10, 0, 0, 10, 30, 20],
  ],
};

function evaluate(s) {
  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = s.board[r][c];
      if (!p) continue;
      const table = PST[p.type];
      const posValue = p.color === "w" ? table[r][c] : table[7 - r][c];
      const value = PIECE_VALUE[p.type] + posValue;
      score += p.color === "w" ? value : -value;
    }
  }
  return score;
}

function orderedMoves(s, color) {
  const moves = allLegalMoves(s, color);
  moves.sort((a, b) => (b.capture ? 1 : 0) - (a.capture ? 1 : 0));
  return moves;
}

function search(s, depth, alpha, beta, maximizing) {
  const color = maximizing ? "w" : "b";
  const moves = orderedMoves(s, color);

  if (moves.length === 0) {
    if (isKingInCheck(s, color)) return maximizing ? -100000 : 100000;
    return 0;
  }
  if (depth === 0) return evaluate(s);

  if (maximizing) {
    let best = -Infinity;
    for (const m of moves) {
      const clone = cloneState(s);
      applyMove(clone, m);
      best = Math.max(best, search(clone, depth - 1, alpha, beta, false));
      alpha = Math.max(alpha, best);
      if (alpha >= beta) break;
    }
    return best;
  } else {
    let best = Infinity;
    for (const m of moves) {
      const clone = cloneState(s);
      applyMove(clone, m);
      best = Math.min(best, search(clone, depth - 1, alpha, beta, true));
      beta = Math.min(beta, best);
      if (alpha >= beta) break;
    }
    return best;
  }
}

function chooseAIMove(s) {
  const tier = DIFFICULTY_TIERS[difficulty];
  const moves = orderedMoves(s, AI_COLOR);
  if (moves.length === 0) return null;

  let bestScore = Infinity;
  let bestMoves = [];
  for (const m of moves) {
    const clone = cloneState(s);
    applyMove(clone, m);
    const score = search(clone, tier.depth - 1, -Infinity, Infinity, true);
    if (score < bestScore) {
      bestScore = score;
      bestMoves = [m];
    } else if (score === bestScore) {
      bestMoves.push(m);
    }
  }
  if (tier.optimal) return bestMoves[0];
  return bestMoves[Math.floor(Math.random() * bestMoves.length)];
}

/* ---------- game flow ---------- */

function updateStatus() {
  const color = state.turn;
  const inCheck = isKingInCheck(state, color);
  const hasMoves = allLegalMoves(state, color).length > 0;
  if (inCheck && !hasMoves) state.status = "checkmate";
  else if (!inCheck && !hasMoves) state.status = "stalemate";
  else if (inCheck) state.status = "check";
  else state.status = "playing";
}

function finishMove(move) {
  applyMove(state, move);
  updateStatus();
  selected = null;
  legalForSelected = [];
  render();

  if (state.status === "checkmate" || state.status === "stalemate") {
    inputLocked = true;
    if (state.status === "checkmate") {
      recordResult(opponent(state.turn));
    }
    return;
  }

  if (state.turn === AI_COLOR) {
    inputLocked = true;
    setTimeout(() => {
      const aiMove = chooseAIMove(state);
      if (aiMove) finishMove(aiMove);
      inputLocked = false;
    }, AI_MOVE_DELAY);
  }
}

/* ---------- piece icons ---------- */

const SVG_NS = "http://www.w3.org/2000/svg";

function pieceIcon(type, color) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "piece-icon");

  const solid = color === "b"; // black = solid fill, white = hollow outline
  const shape = type === "p"
    ? document.createElementNS(SVG_NS, "circle")
    : document.createElementNS(SVG_NS, "path");

  if (type === "p") {
    shape.setAttribute("cx", "12");
    shape.setAttribute("cy", "13");
    shape.setAttribute("r", "6");
  } else {
    shape.setAttribute("d", PIECE_PATHS[type]);
  }

  if (solid) {
    shape.setAttribute("fill", "#ffffff");
  } else {
    shape.setAttribute("fill", "none");
    shape.setAttribute("stroke", "#ffffff");
    shape.setAttribute("stroke-width", "1.6");
    shape.setAttribute("stroke-linejoin", "round");
    shape.setAttribute("stroke-linecap", "round");
  }

  svg.appendChild(shape);
  return svg;
}

/* ---------- scoreboard ---------- */

const WINS_KEY = "perpetualChess.wins";
const LOSSES_KEY = "perpetualChess.losses";
const DIFFICULTY_KEY = "perpetualChess.difficulty";

let wins = Number(localStorage.getItem(WINS_KEY)) || 0;
let losses = Number(localStorage.getItem(LOSSES_KEY)) || 0;
let difficulty = Math.min(Math.max(Number(localStorage.getItem(DIFFICULTY_KEY)) || 0, 0), MAX_DIFFICULTY);

const winCountEl = document.getElementById("winCount");
const lossCountEl = document.getElementById("lossCount");

function renderScoreboard() {
  winCountEl.textContent = wins;
  lossCountEl.textContent = losses;
}

function recordResult(winner) {
  if (winner === HUMAN_COLOR) {
    wins++;
    localStorage.setItem(WINS_KEY, wins);
    difficulty = Math.min(difficulty + 1, MAX_DIFFICULTY);
  } else {
    losses++;
    localStorage.setItem(LOSSES_KEY, losses);
    difficulty = Math.max(difficulty - 1, 0);
  }
  localStorage.setItem(DIFFICULTY_KEY, difficulty);
  renderScoreboard();
}

/* ---------- rendering ---------- */

const boardEl = document.getElementById("board");

function render() {
  boardEl.innerHTML = "";

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const sq = document.createElement("div");
      sq.className = "square";
      sq.dataset.r = r;
      sq.dataset.c = c;

      if (selected && selected.r === r && selected.c === c) {
        sq.classList.add("selected");
      }

      const piece = state.board[r][c];
      if (piece) {
        sq.appendChild(pieceIcon(piece.type, piece.color));
      }

      const moveHere = legalForSelected.find((m) => m.to.r === r && m.to.c === c);
      if (moveHere) {
        const marker = document.createElement("div");
        marker.className = moveHere.capture ? "ring" : "dot";
        sq.appendChild(marker);
      }

      sq.addEventListener("click", onSquareClick);
      boardEl.appendChild(sq);
    }
  }
}

/* ---------- interaction ---------- */

function onSquareClick(e) {
  if (inputLocked || state.turn !== HUMAN_COLOR) return;
  if (state.status === "checkmate" || state.status === "stalemate") return;

  const r = Number(e.currentTarget.dataset.r);
  const c = Number(e.currentTarget.dataset.c);
  const piece = state.board[r][c];

  if (selected) {
    if (selected.r === r && selected.c === c) {
      selected = null; legalForSelected = []; render(); return;
    }
    const match = legalForSelected.find((m) => m.to.r === r && m.to.c === c);
    if (match) {
      finishMove(match);
      return;
    }
    if (piece && piece.color === HUMAN_COLOR) {
      selected = { r, c };
      legalForSelected = legalMovesForPiece(state, r, c);
      render();
      return;
    }
    selected = null; legalForSelected = []; render();
    return;
  }

  if (piece && piece.color === HUMAN_COLOR) {
    selected = { r, c };
    legalForSelected = legalMovesForPiece(state, r, c);
    render();
  }
}

/* ---------- init ---------- */

state = newGameState();
renderScoreboard();
render();
