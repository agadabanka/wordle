/**
 * Wordle — TypeScript IL game spec using @engine SDK.
 *
 * Guess a 5-letter word in 6 tries. After each guess, letters are
 * colored green (correct position), yellow (wrong position), or
 * gray (not in word). AI uses information-gain scoring to pick
 * optimal guesses that maximize pattern diversity.
 */

import { defineGame } from '@engine/core';
import { pickBestMove } from '@engine/ai';
import { consumeAction } from '@engine/input';
import { clearCanvas, drawRoundedRect, drawLabel, drawGameOver } from '@engine/render';
import { drawTouchOverlay } from '@engine/touch';
import {
  evaluateGuess, getLetterStates, generateWordList, pickWord,
  drawKeyboard, drawGuessGrid, LETTER_COLORS, scoreGuessForAI,
} from '@engine/text';

// ── Constants ───────────────────────────────────────────────────────

const WORD_LENGTH = 5;
const MAX_GUESSES = 6;
const CANVAS_W = 420;
const CANVAS_H = 650;

const CELL_SIZE = 52;
const CELL_GAP = 6;
const GRID_W = WORD_LENGTH * (CELL_SIZE + CELL_GAP) - CELL_GAP;
const GRID_X = Math.floor((CANVAS_W - GRID_W) / 2);
const GRID_Y = 60;

const KB_Y = GRID_Y + MAX_GUESSES * (CELL_SIZE + CELL_GAP) + 20;
const KB_X = Math.floor((CANVAS_W - 10 * (34 + 5) + 5) / 2);

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

const BG_COLOR = '#121213';
const TITLE_COLOR = '#ffffff';
const MSG_COLOR = '#888888';
const CURSOR_COLOR = '#565758';
const CURSOR_ACTIVE_COLOR = '#838384';

// ── Game Definition ─────────────────────────────────────────────────

const game = defineGame({
  display: {
    type: 'custom',
    width: WORD_LENGTH,
    height: MAX_GUESSES,
    cellSize: CELL_SIZE,
    canvasWidth: CANVAS_W,
    canvasHeight: CANVAS_H,
    offsetX: GRID_X,
    offsetY: GRID_Y,
    background: BG_COLOR,
  },
  input: {
    up:      { keys: ['ArrowUp', 'w'] },
    down:    { keys: ['ArrowDown', 's'] },
    left:    { keys: ['ArrowLeft', 'a'] },
    right:   { keys: ['ArrowRight', 'd'] },
    select:  { keys: [' ', 'Enter'] },
    restart: { keys: ['r', 'R'] },
  },
});

// ── Resources ───────────────────────────────────────────────────────

game.resource('state', {
  score: 0,
  gameOver: false,
  won: false,
  message: 'Guess the word!',
  guessCount: 0,
});

game.resource('board', {
  target: '',
  guesses: [],
  currentGuess: ['', '', '', '', ''],
  cursorPos: 0,
  wordList: [],
  letterStates: {},
  initialized: false,
});

game.resource('_aiTimer', { elapsed: 0 });

game.resource('_aiState', {
  possibleWords: [],
  currentLetterIdx: 0,
  phase: 'thinking',  // 'thinking' | 'filling' | 'submitting' | 'waiting'
});

// ── Init System ─────────────────────────────────────────────────────

game.system('init', function initSystem(world, _dt) {
  const board = world.getResource('board');
  if (board.initialized) return;
  board.initialized = true;

  board.wordList = generateWordList();
  board.target = pickWord(board.wordList);
  board.guesses = [];
  board.currentGuess = ['', '', '', '', ''];
  board.cursorPos = 0;
  board.letterStates = {};

  // Initialize AI state
  const aiState = world.getResource('_aiState');
  aiState.possibleWords = [...board.wordList];
  aiState.currentLetterIdx = 0;
  aiState.phase = 'thinking';
});

// ── Player Input System ─────────────────────────────────────────────

game.system('playerInput', function playerInputSystem(world, _dt) {
  const gm = world.getResource('gameMode');
  if (!gm || gm.mode !== 'playerVsAi') return;

  const state = world.getResource('state');
  if (state.gameOver) return;

  const input = world.getResource('input');
  const board = world.getResource('board');

  // Navigate cursor position (0-4)
  if (consumeAction(input, 'left')) {
    board.cursorPos = Math.max(0, board.cursorPos - 1);
  }
  if (consumeAction(input, 'right')) {
    board.cursorPos = Math.min(WORD_LENGTH - 1, board.cursorPos + 1);
  }

  // Cycle letters at current cursor position
  if (consumeAction(input, 'up')) {
    const current = board.currentGuess[board.cursorPos];
    if (current === '') {
      board.currentGuess[board.cursorPos] = 'a';
    } else {
      const idx = ALPHABET.indexOf(current);
      board.currentGuess[board.cursorPos] = ALPHABET[(idx + 1) % 26];
    }
  }
  if (consumeAction(input, 'down')) {
    const current = board.currentGuess[board.cursorPos];
    if (current === '') {
      board.currentGuess[board.cursorPos] = 'z';
    } else {
      const idx = ALPHABET.indexOf(current);
      board.currentGuess[board.cursorPos] = ALPHABET[(idx + 25) % 26];
    }
  }

  // Submit guess
  if (consumeAction(input, 'select')) {
    submitGuess(board, state);
  }
});

// ── Guess Submission ────────────────────────────────────────────────

function submitGuess(board, state) {
  // Check all slots filled
  if (board.currentGuess.some(l => l === '')) {
    state.message = 'Fill all 5 letters!';
    return false;
  }

  const word = board.currentGuess.join('');

  // Check if word is in the list
  if (!board.wordList.includes(word)) {
    state.message = 'Not in word list!';
    return false;
  }

  // Evaluate the guess
  const result = evaluateGuess(word, board.target);
  board.guesses.push(result);
  state.guessCount++;

  // Update letter states for keyboard coloring
  const stateMap = getLetterStates(
    board.guesses.map(g => g.map(c => c.letter).join('')),
    board.target
  );
  board.letterStates = {};
  stateMap.forEach((val, key) => { board.letterStates[key] = val; });

  // Check win
  if (word === board.target) {
    state.gameOver = true;
    state.won = true;
    state.score = (MAX_GUESSES - state.guessCount + 1) * 100;
    state.message = `Brilliant! Found in ${state.guessCount} ${state.guessCount === 1 ? 'guess' : 'guesses'}!`;
    return true;
  }

  // Check loss
  if (state.guessCount >= MAX_GUESSES) {
    state.gameOver = true;
    state.won = false;
    state.score = 0;
    state.message = `The word was: ${board.target.toUpperCase()}`;
    return true;
  }

  // Reset for next guess
  board.currentGuess = ['', '', '', '', ''];
  board.cursorPos = 0;
  state.message = `${MAX_GUESSES - state.guessCount} guesses remaining`;
  return true;
}

// ── AI System ───────────────────────────────────────────────────────

const AI_THINK_DELAY = 300;
const AI_LETTER_DELAY = 80;
const AI_SUBMIT_DELAY = 200;

game.system('ai', function aiSystem(world, dt) {
  const gm = world.getResource('gameMode');
  if (gm && gm.mode === 'playerVsAi') return;

  const state = world.getResource('state');
  if (state.gameOver) return;

  const timer = world.getResource('_aiTimer');
  const aiState = world.getResource('_aiState');
  const board = world.getResource('board');

  timer.elapsed += dt;

  // Phase: thinking — pick the best word
  if (aiState.phase === 'thinking') {
    if (timer.elapsed < AI_THINK_DELAY) return;
    timer.elapsed = 0;

    const bestWord = pickAIGuess(aiState.possibleWords, board.wordList, state.guessCount);
    aiState.chosenWord = bestWord;
    aiState.currentLetterIdx = 0;
    aiState.phase = 'filling';
    state.message = 'AI is thinking...';
    return;
  }

  // Phase: filling — place letters one at a time for visual effect
  if (aiState.phase === 'filling') {
    if (timer.elapsed < AI_LETTER_DELAY) return;
    timer.elapsed = 0;

    const idx = aiState.currentLetterIdx;
    if (idx < WORD_LENGTH) {
      board.currentGuess[idx] = aiState.chosenWord[idx];
      board.cursorPos = idx;
      aiState.currentLetterIdx++;
    } else {
      aiState.phase = 'submitting';
    }
    return;
  }

  // Phase: submitting — submit the guess
  if (aiState.phase === 'submitting') {
    if (timer.elapsed < AI_SUBMIT_DELAY) return;
    timer.elapsed = 0;

    const word = board.currentGuess.join('');
    submitGuess(board, state);

    // Filter possible words based on the result
    if (!state.gameOver && board.guesses.length > 0) {
      const lastResult = board.guesses[board.guesses.length - 1];
      aiState.possibleWords = filterPossibleWords(
        aiState.possibleWords, word, lastResult
      );
    }

    aiState.phase = state.gameOver ? 'done' : 'waiting';
    return;
  }

  // Phase: waiting — brief pause before next guess
  if (aiState.phase === 'waiting') {
    if (timer.elapsed < AI_THINK_DELAY) return;
    timer.elapsed = 0;
    aiState.phase = 'thinking';
  }
});

// ── AI Helpers ──────────────────────────────────────────────────────

/**
 * Pick the best guess for the AI using information gain scoring.
 * On the first guess, use a known strong opener. Otherwise, score
 * all candidates and pick the one that creates the most pattern
 * diversity among remaining possible words.
 */
function pickAIGuess(possibleWords, fullWordList, guessCount) {
  // Strong openers that cover common letters
  const OPENERS = ['crane', 'slate', 'trace', 'arise', 'stare'];

  if (guessCount === 0) {
    // Pick a strong opener that exists in the word list
    for (const opener of OPENERS) {
      if (fullWordList.includes(opener)) return opener;
    }
    return pickWord(possibleWords);
  }

  // If only one or two words left, just guess the first one
  if (possibleWords.length <= 2) {
    return possibleWords[0];
  }

  // Score candidates — use possible words as candidates if small enough,
  // otherwise sample from the full list for speed
  let candidates;
  if (possibleWords.length <= 20) {
    candidates = possibleWords;
  } else {
    // Mix possible words with some from the full list for diversity
    const sampled = new Set(possibleWords.slice(0, 30));
    for (let i = 0; i < 20 && sampled.size < 50; i++) {
      sampled.add(fullWordList[Math.floor(Math.random() * fullWordList.length)]);
    }
    candidates = [...sampled];
  }

  let bestWord = candidates[0];
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = scoreGuessForAI(candidate, possibleWords);
    // Prefer words that are themselves possible answers
    const bonus = possibleWords.includes(candidate) ? 0.5 : 0;
    if (score + bonus > bestScore) {
      bestScore = score + bonus;
      bestWord = candidate;
    }
  }

  return bestWord;
}

/**
 * Filter possible words based on a guess result.
 * A word remains possible only if evaluating the guess against it
 * would produce the exact same color pattern.
 */
function filterPossibleWords(possibleWords, guess, result) {
  const pattern = result.map(r => r.state).join(',');

  return possibleWords.filter(word => {
    if (word === guess) return false;
    const evalResult = evaluateGuess(guess, word);
    const wordPattern = evalResult.map(r => r.state).join(',');
    return wordPattern === pattern;
  });
}

// ── Render System ───────────────────────────────────────────────────

game.system('render', function renderSystem(world, _dt) {
  const renderer = world.getResource('renderer');
  if (!renderer) return;

  const { ctx } = renderer;
  const state = world.getResource('state');
  const board = world.getResource('board');

  clearCanvas(ctx, BG_COLOR);

  // ── Title ──
  ctx.save();
  ctx.font = 'bold 28px sans-serif';
  ctx.fillStyle = TITLE_COLOR;
  ctx.textAlign = 'center';
  ctx.letterSpacing = '4px';
  ctx.fillText('WORDLE', CANVAS_W / 2, 38);
  ctx.restore();

  // ── Score indicator ──
  ctx.save();
  ctx.font = '12px sans-serif';
  ctx.fillStyle = MSG_COLOR;
  ctx.textAlign = 'right';
  ctx.fillText(`Score: ${state.score}`, CANVAS_W - 15, 20);
  ctx.restore();

  // ── Guess Grid ──
  // Build the evaluated rows plus the current in-progress row
  const gridRows = [];

  // Already-submitted guesses (evaluated)
  for (let i = 0; i < board.guesses.length; i++) {
    gridRows.push(board.guesses[i]);
  }

  // Current guess row (not yet submitted)
  if (board.guesses.length < MAX_GUESSES && !state.gameOver) {
    const currentRow = board.currentGuess.map((letter, idx) => {
      if (letter === '') return null;
      return { letter, state: 'empty' };
    });
    gridRows.push(currentRow);
  }

  // Draw evaluated rows using the SDK grid renderer
  drawGuessGrid(
    ctx, GRID_X, GRID_Y,
    board.guesses, MAX_GUESSES, WORD_LENGTH, CELL_SIZE,
    { gap: CELL_GAP }
  );

  // Draw current guess row on top of the empty row
  const currentRowIdx = board.guesses.length;
  if (currentRowIdx < MAX_GUESSES && !state.gameOver) {
    const rowY = GRID_Y + currentRowIdx * (CELL_SIZE + CELL_GAP);

    ctx.save();
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let c = 0; c < WORD_LENGTH; c++) {
      const cx = GRID_X + c * (CELL_SIZE + CELL_GAP);
      const letter = board.currentGuess[c];
      const isCursor = (c === board.cursorPos);

      // Cell background
      if (letter !== '') {
        ctx.fillStyle = isCursor ? CURSOR_ACTIVE_COLOR : CURSOR_COLOR;
        ctx.fillRect(cx, rowY, CELL_SIZE, CELL_SIZE);
        // Letter
        ctx.fillStyle = TITLE_COLOR;
        ctx.fillText(letter.toUpperCase(), cx + CELL_SIZE / 2, rowY + CELL_SIZE / 2);
      } else {
        // Empty cell with cursor highlight
        ctx.fillStyle = BG_COLOR;
        ctx.fillRect(cx, rowY, CELL_SIZE, CELL_SIZE);
        ctx.strokeStyle = isCursor ? CURSOR_ACTIVE_COLOR : LETTER_COLORS.border;
        ctx.lineWidth = isCursor ? 3 : 2;
        ctx.strokeRect(cx, rowY, CELL_SIZE, CELL_SIZE);
      }
    }

    // Draw cursor indicator (small triangle below the active cell)
    const cursorCx = GRID_X + board.cursorPos * (CELL_SIZE + CELL_GAP) + CELL_SIZE / 2;
    const cursorCy = rowY + CELL_SIZE + 4;
    ctx.fillStyle = CURSOR_ACTIVE_COLOR;
    ctx.beginPath();
    ctx.moveTo(cursorCx - 5, cursorCy);
    ctx.lineTo(cursorCx + 5, cursorCy);
    ctx.lineTo(cursorCx, cursorCy + 5);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  // ── On-screen Keyboard ──
  const letterStateMap = new Map();
  for (const key of Object.keys(board.letterStates)) {
    letterStateMap.set(key, board.letterStates[key]);
  }

  drawKeyboard(ctx, KB_X, KB_Y, letterStateMap, {
    keyWidth: 34,
    keyHeight: 44,
    gap: 5,
    font: 'bold 14px sans-serif',
  });

  // ── Message ──
  ctx.save();
  ctx.font = '14px sans-serif';
  ctx.fillStyle = MSG_COLOR;
  ctx.textAlign = 'center';
  const msgY = KB_Y + 3 * (44 + 5) + 15;
  ctx.fillText(state.message, CANVAS_W / 2, msgY);
  ctx.restore();

  // ── Controls hint ──
  if (!state.gameOver) {
    ctx.save();
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#555555';
    ctx.textAlign = 'center';
    ctx.fillText(
      '\u2190\u2192 move  \u2191\u2193 letter  ENTER submit  R restart',
      CANVAS_W / 2, CANVAS_H - 12
    );
    ctx.restore();
  }

  // ── Game Over overlay ──
  if (state.gameOver) {
    drawGameOver(ctx, GRID_X, GRID_Y, GRID_W, MAX_GUESSES * (CELL_SIZE + CELL_GAP), {
      title: state.won ? 'YOU WIN!' : 'GAME OVER',
      titleColor: state.won ? LETTER_COLORS.correct : '#d32f2f',
      subtitle: state.won
        ? `Score: ${state.score} | ${state.guessCount} ${state.guessCount === 1 ? 'guess' : 'guesses'} | Press R`
        : `Word: ${board.target.toUpperCase()} | Press R`,
    });
  }

  drawTouchOverlay(ctx, ctx.canvas.width, ctx.canvas.height);
});

export default game;
