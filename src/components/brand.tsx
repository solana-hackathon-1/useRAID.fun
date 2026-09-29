import styles from './brand.module.css';

export function BrandMark() {
  return (
    <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path
        d="M8 32 13 8h15l5 6-3 9h-9l8 9h-9l-7-9-2 9H8Zm10-18-1 4h8l1-4h-8Z"
        fill="currentColor"
      />
      <path d="m33 4 3 3M36 12h3M29 1l1 3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function RaidArtwork() {
  return (
    <div className={styles.artwork} aria-hidden="true">
      <div className={styles.bands}>
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className={styles.word}>RAID</div>
      <div className={styles.caption}>
        <span /> Built to be heard <span />
      </div>
    </div>
  );
}
