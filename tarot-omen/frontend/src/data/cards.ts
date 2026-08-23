export interface TarotCard {
  id: string;
  name: string;
  arcana: 'major' | 'minor';
  suit?: 'Wands' | 'Cups' | 'Swords' | 'Pentacles';
  upright: string;
  reversed: string;
}

// Standard 78-card Rider-Waite deck.
// Keyword meanings are intentionally concise — they are context fed to the AI,
// which produces the full interpretation relative to the user's question.

const majorArcana: TarotCard[] = [
  { id: 'major-00', name: 'The Fool', arcana: 'major', upright: 'new beginnings, innocence, a leap of faith, spontaneity', reversed: 'recklessness, hesitation, poor judgment, being naive' },
  { id: 'major-01', name: 'The Magician', arcana: 'major', upright: 'willpower, resourcefulness, taking action, having the right tools', reversed: 'manipulation, untapped potential, poor planning' },
  { id: 'major-02', name: 'The High Priestess', arcana: 'major', upright: 'intuition, hidden knowledge, stillness, inner voice', reversed: 'secrets withheld, disconnection from intuition, confusion' },
  { id: 'major-03', name: 'The Empress', arcana: 'major', upright: 'abundance, nurturing, growth, creativity', reversed: 'stagnation, dependence, neglect, blocked creativity' },
  { id: 'major-04', name: 'The Emperor', arcana: 'major', upright: 'structure, authority, discipline, stability', reversed: 'rigidity, loss of control, domination, lack of discipline' },
  { id: 'major-05', name: 'The Hierophant', arcana: 'major', upright: 'tradition, conformity, guidance, shared belief', reversed: 'breaking convention, personal beliefs, restriction' },
  { id: 'major-06', name: 'The Lovers', arcana: 'major', upright: 'connection, alignment of values, a meaningful choice', reversed: 'imbalance, misalignment, a difficult choice, disharmony' },
  { id: 'major-07', name: 'The Chariot', arcana: 'major', upright: 'determination, willpower, forward motion, control', reversed: 'lack of direction, loss of control, aggression' },
  { id: 'major-08', name: 'Strength', arcana: 'major', upright: 'inner strength, patience, courage, compassion', reversed: 'self-doubt, insecurity, low energy, forcing an outcome' },
  { id: 'major-09', name: 'The Hermit', arcana: 'major', upright: 'introspection, solitude, seeking inner guidance', reversed: 'isolation, withdrawal, loneliness, avoidance' },
  { id: 'major-10', name: 'Wheel of Fortune', arcana: 'major', upright: 'cycles, turning points, fate, change', reversed: 'resistance to change, bad timing, feeling stuck' },
  { id: 'major-11', name: 'Justice', arcana: 'major', upright: 'fairness, truth, cause and effect, accountability', reversed: 'unfairness, avoiding responsibility, dishonesty' },
  { id: 'major-12', name: 'The Hanged Man', arcana: 'major', upright: 'pause, surrender, new perspective, letting go', reversed: 'stalling, resistance, needless sacrifice, indecision' },
  { id: 'major-13', name: 'Death', arcana: 'major', upright: 'endings, transformation, transition, release', reversed: 'resistance to change, fear of endings, stagnation' },
  { id: 'major-14', name: 'Temperance', arcana: 'major', upright: 'balance, moderation, patience, integration', reversed: 'imbalance, excess, discord, impatience' },
  { id: 'major-15', name: 'The Devil', arcana: 'major', upright: 'attachment, restriction, temptation, unhealthy patterns', reversed: 'release, breaking free, reclaiming power' },
  { id: 'major-16', name: 'The Tower', arcana: 'major', upright: 'sudden change, upheaval, revelation, disruption', reversed: 'avoiding disaster, delayed change, fear of change' },
  { id: 'major-17', name: 'The Star', arcana: 'major', upright: 'hope, renewal, inspiration, faith in the future', reversed: 'discouragement, disconnection, lost hope' },
  { id: 'major-18', name: 'The Moon', arcana: 'major', upright: 'uncertainty, illusion, subconscious, anxiety', reversed: 'clarity emerging, releasing fear, confusion lifting' },
  { id: 'major-19', name: 'The Sun', arcana: 'major', upright: 'joy, success, vitality, clarity', reversed: 'temporary setback, low energy, unmet expectations' },
  { id: 'major-20', name: 'Judgement', arcana: 'major', upright: 'reflection, reckoning, a turning point, self-evaluation', reversed: 'self-doubt, avoiding reflection, harsh self-judgment' },
  { id: 'major-21', name: 'The World', arcana: 'major', upright: 'completion, fulfillment, wholeness, achievement', reversed: 'incompletion, delay, lacking closure' },
];

const suits: Array<'Wands' | 'Cups' | 'Swords' | 'Pentacles'> = ['Wands', 'Cups', 'Swords', 'Pentacles'];

const suitThemes: Record<string, { upright: string; reversed: string }> = {
  Wands: { upright: 'ambition, energy, passion, action', reversed: 'delays, frustration, scattered energy' },
  Cups: { upright: 'emotion, relationships, intuition, connection', reversed: 'emotional imbalance, unmet feelings, disconnection' },
  Swords: { upright: 'thought, conflict, truth, communication', reversed: 'confusion, miscommunication, overthinking' },
  Pentacles: { upright: 'material matters, work, resources, stability', reversed: 'insecurity, delay, mismanaged resources' },
};

const rankMeanings: Array<{ rank: string; upright: string; reversed: string }> = [
  { rank: 'Ace', upright: 'a fresh start, raw potential, an opening', reversed: 'a missed opportunity, a false start' },
  { rank: 'Two', upright: 'balance, partnership, a choice', reversed: 'imbalance, indecision, a stalled connection' },
  { rank: 'Three', upright: 'growth, expansion, early results', reversed: 'delay, lack of support, slow progress' },
  { rank: 'Four', upright: 'stability, structure, a pause to consolidate', reversed: 'stagnation, restriction, resistance to change' },
  { rank: 'Five', upright: 'conflict, challenge, tension', reversed: 'avoiding conflict, resolution after struggle' },
  { rank: 'Six', upright: 'cooperation, progress, moving forward', reversed: 'setback, imbalance in give and take' },
  { rank: 'Seven', upright: 'assessment, perseverance, a test', reversed: 'giving up too soon, lack of confidence' },
  { rank: 'Eight', upright: 'movement, mastery, focused effort', reversed: 'scattered effort, feeling stuck' },
  { rank: 'Nine', upright: 'resilience, near completion, close to the goal', reversed: 'exhaustion, doubt near the finish line' },
  { rank: 'Ten', upright: 'culmination, fulfillment, the end of a cycle', reversed: 'burden, an overdue ending, burnout' },
  { rank: 'Page', upright: 'curiosity, a message, a new perspective forming', reversed: 'immaturity, hesitation, a delayed message' },
  { rank: 'Knight', upright: 'momentum, pursuit, direct action', reversed: 'recklessness, impatience, misdirected energy' },
  { rank: 'Queen', upright: 'nurturing mastery, emotional intelligence, confidence', reversed: 'insecurity, overwhelm, withdrawn energy' },
  { rank: 'King', upright: 'mastery, leadership, command of the area', reversed: 'misuse of power, rigidity, poor judgment' },
];

const minorArcana: TarotCard[] = [];
for (const suit of suits) {
  for (const r of rankMeanings) {
    minorArcana.push({
      id: `${suit.toLowerCase()}-${r.rank.toLowerCase()}`,
      name: `${r.rank} of ${suit}`,
      arcana: 'minor',
      suit,
      upright: `${r.upright} (${suitThemes[suit].upright})`,
      reversed: `${r.reversed} (${suitThemes[suit].reversed})`,
    });
  }
}

export const DECK: TarotCard[] = [...majorArcana, ...minorArcana];

export interface DrawnCard {
  card: TarotCard;
  orientation: 'upright' | 'reversed';
}

export const POSITIONS = [
  { key: 'situation', label: 'The Situation' },
  { key: 'influence', label: 'What Influences It' },
  { key: 'outcome', label: 'Where It May Lead' },
] as const;

export function drawThreeCards(): DrawnCard[] {
  const shuffled = [...DECK].sort(() => Math.random() - 0.5);
  const chosen = shuffled.slice(0, 3);
  return chosen.map((card) => ({
    card,
    orientation: Math.random() < 0.5 ? 'upright' : 'reversed',
  }));
}
