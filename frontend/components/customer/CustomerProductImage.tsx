import { ComponentType, useEffect, useState } from 'react';

type Props = {
  src: string | null;
  alt: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  iconClassName: string;
  className?: string;
  priority?: boolean;
};

export default function CustomerProductImage({
  src,
  alt,
  icon: Icon,
  iconClassName,
  className = '',
  priority = false,
}: Props) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [src]);

  const showImage = Boolean(src) && !failed;

  return (
    <div className={`relative shrink-0 overflow-hidden rounded-2xl bg-[#f1e8df] ${className}`}>
      {showImage && (
        <img
          src={src || ''}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
          width="400"
          height="300"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 motion-reduce:transition-none ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
      {!loaded && showImage && <div className="absolute inset-0 animate-pulse bg-[#e8ddd2] motion-reduce:animate-none" aria-hidden="true" />}
      {(!showImage || failed) && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#f1e8df]" role="img" aria-label={`${alt} image unavailable`}>
          <Icon size={25} className={iconClassName} />
        </div>
      )}
    </div>
  );
}
