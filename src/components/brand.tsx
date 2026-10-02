import Image from 'next/image';
import styles from './brand.module.css';

export function BrandMark() {
  return <Image src="/brand/raid-logo.png" width={44} height={44} alt="" aria-hidden="true" />;
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
