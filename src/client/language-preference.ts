import {
  AUTOMATIC_LANGUAGE_DETECTION,
  getDefaultTranscriptionSettings,
  type TranscriptionSettings,
} from '../shared/transcription';

export const ENGLISH_LANGUAGE = 'en';
export const TAGALOG_FILIPINO_LANGUAGE = 'tl';

export interface LanguageOption {
  readonly value: TranscriptionSettings;
  readonly label: string;
}

/** The catalogue can be extended by the application without changing the control. */
export const DEFAULT_LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  {
    value: AUTOMATIC_LANGUAGE_DETECTION,
    label: 'Automatic language detection',
  },
  {
    value: ENGLISH_LANGUAGE,
    label: 'English',
  },
  {
    value: TAGALOG_FILIPINO_LANGUAGE,
    label: 'Tagalog / Filipino',
  },
];

export interface LanguagePreferenceControlElements {
  readonly root: HTMLDivElement;
  readonly label: HTMLLabelElement;
  readonly select: HTMLSelectElement;
}

export interface LanguagePreferenceControlOptions {
  readonly id?: string;
  readonly options?: readonly LanguageOption[];
  readonly onChange?: (settings: TranscriptionSettings) => void;
}

export interface LanguagePreferenceControlInstance {
  readonly root: HTMLDivElement;
  readonly elements: LanguagePreferenceControlElements;
  readonly control: LanguagePreferenceControl;
}

/**
 * Owns the accessible source-language select. It starts at automatic detection
 * and forwards the exact selected option value without transforming it.
 */
export class LanguagePreferenceControl {
  private selectedSettings: TranscriptionSettings;
  private readonly onChange: (settings: TranscriptionSettings) => void;

  private readonly handleChange = (): void => {
    const value = this.elements.select.value;
    this.selectedSettings = value || getDefaultTranscriptionSettings();
    if (!value) {
      this.elements.select.value = this.selectedSettings;
    }
    this.onChange(this.selectedSettings);
  };

  constructor(
    private readonly elements: LanguagePreferenceControlElements,
    options: LanguagePreferenceControlOptions = {},
  ) {
    this.onChange = options.onChange ?? (() => undefined);
    this.selectedSettings = getDefaultTranscriptionSettings();
    this.elements.select.value = this.selectedSettings;
    this.elements.select.addEventListener('change', this.handleChange);
  }

  get value(): TranscriptionSettings {
    return this.selectedSettings;
  }

  get disabled(): boolean {
    return this.elements.select.disabled;
  }

  setDisabled(disabled: boolean): void {
    this.elements.select.disabled = disabled;
  }

  /** Programmatic updates do not emit a change event. */
  setValue(settings: TranscriptionSettings): void {
    this.selectedSettings = settings;
    this.elements.select.value = settings;
  }

  destroy(): void {
    this.elements.select.removeEventListener('change', this.handleChange);
  }
}

export function createLanguagePreferenceControl(
  document: Document,
  options: LanguagePreferenceControlOptions = {},
): LanguagePreferenceControlInstance {
  const id = options.id ?? 'language-preference';
  const configuredOptions = options.options ?? DEFAULT_LANGUAGE_OPTIONS;
  const automaticOption: LanguageOption = {
    value: AUTOMATIC_LANGUAGE_DETECTION,
    label: 'Automatic language detection',
  };
  const languageOptions: readonly LanguageOption[] = configuredOptions.some(
    (option) => option.value === AUTOMATIC_LANGUAGE_DETECTION,
  )
    ? configuredOptions
    : [automaticOption, ...configuredOptions];

  const root = document.createElement('div');
  root.className = 'min-w-0';

  const label = document.createElement('label');
  label.htmlFor = id;
  label.className = 'mb-2 block font-geist text-label-md uppercase text-on-surface-variant';
  label.textContent = 'Source language';

  const select = document.createElement('select');
  select.id = id;
  select.className = 'w-full min-w-0 rounded-lg border border-outline-variant bg-surface-container-lowest px-5 py-3 font-inter text-body-sm text-on-surface outline-focus outline-offset-focus focus-visible:outline-2 focus-visible:outline focus-visible:outline-secondary disabled:cursor-not-allowed disabled:opacity-60';
  select.setAttribute('aria-label', 'Source language');

  for (const option of languageOptions) {
    const optionElement = document.createElement('option');
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    select.append(optionElement);
  }

  root.append(label, select);
  const elements: LanguagePreferenceControlElements = { root, label, select };
  const control = new LanguagePreferenceControl(elements, options);

  return { root, elements, control };
}
