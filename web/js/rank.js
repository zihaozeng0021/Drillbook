// Ranking algorithm for Review
//
// Each question's priority P = its smoothed "recency-weighted error rate"
//
//   1) Weight of each attempt  w = 0.5^(days ago / HALF_LIFE) × ORDER_DECAY^(number of attempts after this one)
//        Time decay: an attempt HALF_LIFE days ago counts half (the more recent, the more it matters)
//        Order decay: when practicing repeatedly on the same day, the latest few attempts dominate
//   2) E = sum of the weights of wrong answers, C = sum of the weights of correct answers
//   3) P = (E + K·P0) / (E + C + K)      Bayesian smoothing: as if each question started with K virtual attempts at error rate P0
//
// Properties:
//   · A question never answered has P = P0 (40) and sits in the middle
//   · P > P0 ⇔ the recency-weighted error rate is above 40%; classed as "Weak", ranked before New questions
//   · Answering correctly right after a wrong answer on the same day still leaves P above P0; only a correct answer a day or more later brings it below P0
//   · With no practice for a long time all evidence decays and P drifts back to P0: questions answered wrong come down from above, ones answered right rise from below
//   · Questions that are always answered correctly have the lowest P and come last, but are still included in the list

export const RANK = {
  HALF_LIFE_DAYS: 7,
  ORDER_DECAY: 0.75,
  P0: 0.4,
  K: 2,
  GOOD_BELOW: 0.25,
};

const DAY = 86_400_000;

export const STATES = ['weak', 'new', 'fair', 'good'];
export const STATE_LABEL = { weak: 'Weak', new: 'New', fair: 'Fair', good: 'Mastered' };

export function scoreAttempts(attempts, now = Date.now()) {
  const n = attempts.length;
  let E = 0;
  let C = 0;
  let correct = 0;
  let lastWrongT = 0;
  for (let i = 0; i < n; i++) {
    const a = attempts[i];
    const days = Math.max(0, now - a.t) / DAY;
    const w = Math.pow(0.5, days / RANK.HALF_LIFE_DAYS) * Math.pow(RANK.ORDER_DECAY, n - 1 - i);
    if (a.ok) {
      C += w;
      correct++;
    } else {
      E += w;
      lastWrongT = a.t;
    }
  }
  const P = (E + RANK.K * RANK.P0) / (E + C + RANK.K);
  let state;
  if (n === 0) state = 'new';
  else if (P > RANK.P0 + 1e-9) state = 'weak';
  else if (P < RANK.GOOD_BELOW) state = 'good';
  else state = 'fair';
  const last = n ? attempts[n - 1] : null;
  return { n, correct, E, C, P, score: Math.round(P * 100), state, last, lastWrongT };
}

// questions: all questions (with gid, order); attempts: Map<gid, answer records in ascending time order>
export function computeStats(questions, attempts, now = Date.now()) {
  const map = new Map();
  for (const q of questions) map.set(q.gid, scoreAttempts(attempts.get(q.gid) || [], now));
  return map;
}

// Sorts by priority, highest first; on a tie: last answer wrong first → most recently answered first → original question bank order
export function rankQuestions(questions, stats) {
  return [...questions].sort((a, b) => {
    const sa = stats.get(a.gid);
    const sb = stats.get(b.gid);
    return (
      sb.P - sa.P ||
      (sa.last && !sa.last.ok ? 0 : 1) - (sb.last && !sb.last.ok ? 0 : 1) ||
      (sb.last ? sb.last.t : 0) - (sa.last ? sa.last.t : 0) ||
      a.order - b.order
    );
  });
}

export function countStates(questions, stats) {
  const c = { weak: 0, new: 0, fair: 0, good: 0 };
  for (const q of questions) c[stats.get(q.gid).state]++;
  return c;
}

// State of a knowledge point: Weak if any linked question is Weak; New if all are New; Mastered if all are Mastered; otherwise Fair
export function aggregateState(states) {
  if (!states.length) return 'new';
  if (states.includes('weak')) return 'weak';
  if (states.every((s) => s === 'new')) return 'new';
  if (states.every((s) => s === 'good')) return 'good';
  return 'fair';
}
