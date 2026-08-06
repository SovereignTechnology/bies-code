import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import Lightbox from "yet-another-react-lightbox";
import { Captions, Zoom } from "yet-another-react-lightbox/plugins";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/captions.css";
import type { ImageGallerySlide } from "@/components/ImageGallery";

interface ImageLightboxProps {
  open: boolean;
  slides: ImageGallerySlide[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

export default function ImageLightbox({
  open,
  slides,
  index,
  onClose,
  onIndexChange,
}: ImageLightboxProps) {
  const currentSlide = slides[index] ?? slides[0];
  const lightboxSlides = useMemo(
    () =>
      slides.map((slide) => ({
        src: slide.src,
        alt: slide.alt,
        title: slide.alt,
      })),
    [slides],
  );

  return (
    <Lightbox
      open={open}
      close={onClose}
      slides={lightboxSlides}
      index={index}
      on={{ view: ({ index: nextIndex }) => onIndexChange(nextIndex) }}
      plugins={[Captions, Zoom]}
      captions={{ showToggle: false, descriptionMaxLines: 3 }}
      zoom={{ pinchZoomV4: true, scrollToZoom: true }}
      controller={{ closeOnBackdropClick: true }}
      toolbar={{
        buttons: [
          currentSlide && (
            <a
              key="open-original"
              href={currentSlide.src}
              target="_blank"
              rel="noopener noreferrer"
              className="yarl__button"
              title="Open original"
              aria-label="Open original image in a new tab"
            >
              <ExternalLink aria-hidden="true" />
            </a>
          ),
          "zoom",
          "close",
        ],
      }}
      labels={{
        Lightbox: "Image viewer",
        "Photo gallery": "Image gallery",
      }}
    />
  );
}
