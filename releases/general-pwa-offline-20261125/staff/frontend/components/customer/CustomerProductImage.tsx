import { ComponentType, useCallback, useState } from 'react';
import { IS_CUSTOMER_ORIGIN_BUILD } from '../../lib/customerRoutes';

type Props = {
  src: string | null;
  alt: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  iconClassName: string;
  className?: string;
  priority?: boolean;
};

type ImageStatus = 'loading' | 'loaded' | 'failed';

type ImageState = {
  src: string;
  status: ImageStatus;
};

export default function CustomerProductImage({
  src,
  alt,
  icon: Icon,
  iconClassName,
  className = '',
  priority = false,
}: Props) {
  const [imageState, setImageState] = useState<ImageState | null>(null);

  const setStatus = useCallback((status: ImageStatus) => {
    if (!src) return;
    setImageState((current) => (
      current?.src === src && current.status === status
        ? current
        : { src, status }
    ));
  }, [src]);

  const captureImage = useCallback((image: HTMLImageElement | null) => {
    if (!image?.complete) return;
    setStatus(image.naturalWidth > 0 ? 'loaded' : 'failed');
  }, [setStatus]);

  const status: ImageStatus = Boolean(src) && imageState?.src === src
    ? imageState.status
    : 'loading';
  const loaded = Boolean(src) && status === 'loaded';
  const failed = Boolean(src) && status === 'failed';
  const showImage = Boolean(src) && !failed;

  return (
    <div className={`relative shrink-0 overflow-hidden rounded-2xl bg-[#f1e8df] ${className}`}>
      {showImage && (
        <img
          key={src}
          ref={captureImage}
          src={src || ''}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
          width="400"
          height="300"
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('failed')}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 motion-reduce:transition-none ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
      {!loaded && showImage && <div className="absolute inset-0 animate-pulse bg-[#e8ddd2] motion-reduce:animate-none" aria-hidden="true" />}
      {(!showImage || failed) && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#f1e8df]" role="img" aria-label={`${alt} image unavailable`}>
          {IS_CUSTOMER_ORIGIN_BUILD ? (
            <img
              src="/pwa/coffee-bond-mark.svg"
              alt=""
              width="64"
              height="64"
              aria-hidden="true"
              className="cb-customer-product-fallback-mark"
            />
          ) : (
            <Icon size={25} className={iconClassName} />
          )}
        </div>
      )}
    </div>
  );
}
