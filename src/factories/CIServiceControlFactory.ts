import { blankEventTemplate, EventFactory } from "applesauce-core/factories";
import type { KnownEventTemplate } from "applesauce-core/helpers/event";
import { CI_SERVICE_REQUEST_KIND, CI_SERVICE_STOP_KIND } from "@/lib/ci";

type CIServiceControlKind =
  | typeof CI_SERVICE_REQUEST_KIND
  | typeof CI_SERVICE_STOP_KIND;
type CIServiceControlTemplate = KnownEventTemplate<CIServiceControlKind>;

export class CIServiceControlFactory extends EventFactory<
  CIServiceControlKind,
  CIServiceControlTemplate
> {
  static create(
    kind: CIServiceControlKind,
    repositoryCoordinate: string,
    coordinatorPubkey: string,
    repositoryRelayHint?: string,
  ): CIServiceControlFactory {
    const repositoryTag = repositoryRelayHint
      ? ["a", repositoryCoordinate, repositoryRelayHint]
      : ["a", repositoryCoordinate];

    return new CIServiceControlFactory((resolve) =>
      resolve(blankEventTemplate(kind)),
    )
      .modifyPublicTags((tags) => [
        ...tags,
        repositoryTag,
        ["p", coordinatorPubkey],
      ])
      .alt(
        kind === CI_SERVICE_REQUEST_KIND
          ? "CI service request"
          : "CI service stop",
      );
  }
}
