import { lazy, Suspense, useCallback, useState, type ReactNode } from "react";

const ImageLightbox = lazy(() => import("@/components/ImageLightbox"));

export interface ImageGallerySlide {
  src: string;
  alt: string;
}

export type OpenImageGallery = (
  slides: ImageGallerySlide[],
  index?: number,
) => void;

interface ImageGalleryProps {
  children: (openGallery: OpenImageGallery) => ReactNode;
}

function validIndex(index: number, length: number): number {
  return Math.min(Math.max(index, 0), Math.max(length - 1, 0));
}

/** Owns one lightbox for a logical image group, such as one event or gallery. */
export function ImageGallery({ children }: ImageGalleryProps) {
  const [slides, setSlides] = useState<ImageGallerySlide[]>([]);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  const openGallery = useCallback<OpenImageGallery>(
    (nextSlides, nextIndex = 0) => {
      if (nextSlides.length === 0) return;
      setSlides(nextSlides);
      setIndex(validIndex(nextIndex, nextSlides.length));
      setMounted(true);
      setOpen(true);
    },
    [],
  );

  return (
    <>
      {children(openGallery)}
      {mounted && (
        <Suspense fallback={null}>
          <ImageLightbox
            open={open}
            slides={slides}
            index={index}
            onClose={() => setOpen(false)}
            onIndexChange={setIndex}
          />
        </Suspense>
      )}
    </>
  );
}
