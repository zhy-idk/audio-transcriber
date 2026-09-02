import './styles.css';
import { createTranscriptionPage } from './transcription-page';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('Application root is missing.');
}

const page = createTranscriptionPage(document);
root.replaceChildren(page.root);
