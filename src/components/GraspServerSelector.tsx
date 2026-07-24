import { useId, useState } from "react";
import { Loader2, Plus, Server } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { GraspServer } from "@/hooks/useGraspServers";
import {
  isValidGraspDomain,
  normalizeGraspDomain,
  uniqueGraspDomains,
  validateGraspServer,
} from "@/lib/grasp";
import { DEFAULT_GRASP_SERVERS } from "@/services/settings";

interface GraspServerSelectorProps {
  selectedDomains: string[];
  onSelectedDomainsChange(domains: string[]): void;
  resolvedServers: GraspServer[];
  isFromUserList: boolean;
  additionalDomains?: readonly string[];
  currentDomains?: readonly string[];
  requiredGrasps?: readonly string[];
  disabled?: boolean;
  showTitle?: boolean;
  emptyMessage?: string;
}

/**
 * Shared GRASP server checklist and validated custom-domain input.
 *
 * Repository creation, repository settings, and invitation acceptance all use
 * this component so they apply identical normalization and NIP-11 validation.
 */
export function GraspServerSelector({
  selectedDomains,
  onSelectedDomainsChange,
  resolvedServers,
  isFromUserList,
  additionalDomains = [],
  currentDomains = [],
  requiredGrasps = ["GRASP-01"],
  disabled = false,
  showTitle = true,
  emptyMessage = "Select at least one GRASP server to continue.",
}: GraspServerSelectorProps) {
  const id = useId();
  const [customDomain, setCustomDomain] = useState("");
  const [customDomainError, setCustomDomainError] = useState<
    string | undefined
  >();
  const [validatingDomain, setValidatingDomain] = useState(false);

  const allKnownDomains = uniqueGraspDomains([
    ...resolvedServers.map((server) => server.domain),
    ...additionalDomains,
    ...selectedDomains,
    ...currentDomains,
  ]);

  const toggleServer = (domain: string) => {
    onSelectedDomainsChange(
      selectedDomains.includes(domain)
        ? selectedDomains.filter((candidate) => candidate !== domain)
        : [...selectedDomains, domain],
    );
  };

  const addCustomDomain = async () => {
    const domain = normalizeGraspDomain(customDomain);
    if (!domain) return;
    if (!isValidGraspDomain(domain)) {
      setCustomDomainError("Enter a valid domain (e.g. relay.example.com)");
      return;
    }
    if (selectedDomains.includes(domain)) {
      setCustomDomainError("Already in the list");
      return;
    }

    setValidatingDomain(true);
    setCustomDomainError(undefined);
    const validationError = await validateGraspServer(domain, {
      requiredGrasps,
    });
    setValidatingDomain(false);
    if (validationError) {
      setCustomDomainError(validationError);
      return;
    }

    onSelectedDomainsChange([...selectedDomains, domain]);
    setCustomDomain("");
  };

  return (
    <div className="space-y-3">
      {showTitle && <p className="text-sm font-medium">GRASP servers</p>}

      <div className="space-y-1.5">
        {allKnownDomains.map((domain) => {
          const checked = selectedDomains.includes(domain);
          const isCurrent = currentDomains.includes(domain);
          const isUserList =
            isFromUserList &&
            resolvedServers.some((server) => server.domain === domain);
          const isDefault = DEFAULT_GRASP_SERVERS.includes(domain);

          return (
            <label
              key={domain}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors hover:bg-muted/40"
            >
              <Checkbox
                id={`${id}-${domain}`}
                checked={checked}
                disabled={disabled || validatingDomain}
                onCheckedChange={() => toggleServer(domain)}
              />
              <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-sm">
                {domain}
              </span>
              {isCurrent ? (
                <Badge
                  variant="outline"
                  className="h-4 px-1.5 py-0 text-[10px] text-pink-500"
                >
                  current
                </Badge>
              ) : isUserList ? (
                <Badge
                  variant="secondary"
                  className="h-4 px-1.5 py-0 text-[10px]"
                >
                  your list
                </Badge>
              ) : isDefault ? (
                <Badge
                  variant="outline"
                  className="h-4 px-1.5 py-0 text-[10px] text-muted-foreground"
                >
                  default
                </Badge>
              ) : null}
            </label>
          );
        })}
      </div>

      <div className="space-y-1.5">
        <div className="flex gap-2">
          <Input
            aria-label="New GRASP server domain"
            placeholder="relay.example.com"
            value={customDomain}
            disabled={disabled || validatingDomain}
            onChange={(event) => {
              setCustomDomain(event.target.value);
              setCustomDomainError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void addCustomDomain();
              }
            }}
            className="h-8 font-mono text-sm"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Add GRASP server"
            onClick={() => void addCustomDomain()}
            disabled={disabled || validatingDomain}
            className="h-8 shrink-0 px-2.5"
          >
            {validatingDomain ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        {customDomainError && (
          <p className="px-0.5 text-xs text-red-500">{customDomainError}</p>
        )}
      </div>

      {selectedDomains.length === 0 && (
        <p className="px-0.5 text-xs text-amber-600 dark:text-amber-400">
          {emptyMessage}
        </p>
      )}
    </div>
  );
}
