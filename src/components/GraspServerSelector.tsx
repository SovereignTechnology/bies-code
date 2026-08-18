import { useId, useState } from "react";
import { Loader2, Plus, Server } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { GraspServer } from "@/hooks/useGraspServers";
import {
  isValidGraspServiceAddress,
  normalizeGraspServiceAddress,
  uniqueGraspServiceAddresses,
  validateGraspServer,
} from "@/lib/grasp";
import { DEFAULT_GRASP_SERVERS } from "@/services/settings";

interface GraspServerSelectorProps {
  selectedAddresses: string[];
  onSelectedAddressesChange(addresses: string[]): void;
  resolvedServers: GraspServer[];
  isFromUserList: boolean;
  additionalAddresses?: readonly string[];
  currentAddresses?: readonly string[];
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
  selectedAddresses,
  onSelectedAddressesChange,
  resolvedServers,
  isFromUserList,
  additionalAddresses = [],
  currentAddresses = [],
  requiredGrasps = ["GRASP-01"],
  disabled = false,
  showTitle = true,
  emptyMessage = "Select at least one GRASP server to continue.",
}: GraspServerSelectorProps) {
  const id = useId();
  const [customAddress, setCustomAddress] = useState("");
  const [customAddressError, setCustomAddressError] = useState<
    string | undefined
  >();
  const [validatingAddress, setValidatingAddress] = useState(false);

  const allKnownAddresses = uniqueGraspServiceAddresses([
    ...resolvedServers.map((server) => server.serviceAddress),
    ...additionalAddresses,
    ...selectedAddresses,
    ...currentAddresses,
  ]);

  const toggleServer = (address: string) => {
    onSelectedAddressesChange(
      selectedAddresses.includes(address)
        ? selectedAddresses.filter((candidate) => candidate !== address)
        : [...selectedAddresses, address],
    );
  };

  const addCustomAddress = async () => {
    const address = normalizeGraspServiceAddress(customAddress);
    if (!address) return;
    if (!isValidGraspServiceAddress(address)) {
      setCustomAddressError(
        "Enter a valid service address (e.g. relay.example.com/grasp)",
      );
      return;
    }
    if (selectedAddresses.includes(address)) {
      setCustomAddressError("Already in the list");
      return;
    }

    setValidatingAddress(true);
    setCustomAddressError(undefined);
    const validationError = await validateGraspServer(address, {
      requiredGrasps,
    });
    setValidatingAddress(false);
    if (validationError) {
      setCustomAddressError(validationError);
      return;
    }

    onSelectedAddressesChange([...selectedAddresses, address]);
    setCustomAddress("");
  };

  return (
    <div className="space-y-3">
      {showTitle && <p className="text-sm font-medium">GRASP servers</p>}

      <div className="space-y-1.5">
        {allKnownAddresses.map((address) => {
          const checked = selectedAddresses.includes(address);
          const isCurrent = currentAddresses.includes(address);
          const isUserList =
            isFromUserList &&
            resolvedServers.some((server) => server.serviceAddress === address);
          const isDefault = DEFAULT_GRASP_SERVERS.includes(address);

          return (
            <label
              key={address}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 transition-colors hover:bg-muted/40"
            >
              <Checkbox
                id={`${id}-${address}`}
                checked={checked}
                disabled={disabled || validatingAddress}
                onCheckedChange={() => toggleServer(address)}
              />
              <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-sm">
                {address}
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
            aria-label="New GRASP service address"
            placeholder="relay.example.com/grasp"
            value={customAddress}
            disabled={disabled || validatingAddress}
            onChange={(event) => {
              setCustomAddress(event.target.value);
              setCustomAddressError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void addCustomAddress();
              }
            }}
            className="h-8 font-mono text-sm"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Add GRASP server"
            onClick={() => void addCustomAddress()}
            disabled={disabled || validatingAddress}
            className="h-8 shrink-0 px-2.5"
          >
            {validatingAddress ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        {customAddressError && (
          <p className="px-0.5 text-xs text-red-500">{customAddressError}</p>
        )}
      </div>

      {selectedAddresses.length === 0 && (
        <p className="px-0.5 text-xs text-amber-600 dark:text-amber-400">
          {emptyMessage}
        </p>
      )}
    </div>
  );
}
