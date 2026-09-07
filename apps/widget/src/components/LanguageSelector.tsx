import { h } from 'preact';
import { MARKETS_DATA, MarketCode, SupportedLocale } from '../types.js';

interface LanguageSelectorProps {
  currentLocale: SupportedLocale;
  onChangeLocale: (locale: SupportedLocale) => void;
  disabled?: boolean;
}

export function LanguageSelector({
  currentLocale,
  onChangeLocale,
  disabled = false,
}: LanguageSelectorProps) {
  const markets = Object.values(MARKETS_DATA);

  return (
    <div class="gaga-lang-selector">
      <select
        value={currentLocale}
        disabled={disabled}
        onChange={(e) => {
          const target = e.target as HTMLSelectElement;
          onChangeLocale(target.value as SupportedLocale);
        }}
        class="gaga-lang-select"
        aria-label="Pilih Bahasa"
      >
        {markets.map((m) => (
          <option key={m.code} value={m.defaultLocale}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  );
}
