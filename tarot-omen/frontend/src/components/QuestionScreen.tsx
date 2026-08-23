import { useState } from 'react';

interface Props {
  onReveal: (question: string) => void;
}

export function QuestionScreen({ onReveal }: Props) {
  const [question, setQuestion] = useState('');
  const trimmed = question.trim();

  return (
    <div className="screen question-screen">
      <div>
        <p className="brand">Tarot Omen</p>
        <div className="brand-hair" />
      </div>
      <h1 className="question-title">What is on&nbsp;your mind?</h1>
      <textarea
        className="question-input"
        placeholder="Ask about anything — love, work, a decision, a fear, a hope…"
        value={question}
        maxLength={280}
        onChange={(e) => setQuestion(e.target.value)}
      />
      <button
        className="reveal-btn"
        disabled={trimmed.length === 0}
        onClick={() => onReveal(trimmed)}
      >
        Reveal
      </button>
      <p className="hint">Three cards will be drawn at random and read against your question.</p>
    </div>
  );
}
