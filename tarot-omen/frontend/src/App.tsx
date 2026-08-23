import { useEffect, useState } from 'react';
import { QuestionScreen } from './components/QuestionScreen';
import { RevealScreen } from './components/RevealScreen';
import { InterpretationScreen } from './components/InterpretationScreen';
import type { Screen } from './types';
import type { DrawnCard } from './data/cards';
import { initTelegram } from './telegram';

export default function App() {
  const [screen, setScreen] = useState<Screen>('question');
  const [question, setQuestion] = useState('');
  const [cards, setCards] = useState<DrawnCard[]>([]);

  useEffect(() => {
    initTelegram();
  }, []);

  return (
    <div className="app">
      {screen === 'question' && (
        <QuestionScreen
          onReveal={(q) => {
            setQuestion(q);
            setScreen('reveal');
          }}
        />
      )}

      {screen === 'reveal' && (
        <RevealScreen
          onDone={(drawn) => {
            setCards(drawn);
            setScreen('interpretation');
          }}
        />
      )}

      {screen === 'interpretation' && (
        <InterpretationScreen
          question={question}
          cards={cards}
          onAskAnother={() => {
            setQuestion('');
            setCards([]);
            setScreen('question');
          }}
        />
      )}
    </div>
  );
}
