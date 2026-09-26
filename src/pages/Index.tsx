import { useActiveAccount } from "applesauce-react/hooks";
import { Link } from "react-router-dom";
import { Dashboard } from "./Dashboard";
import RepositoriesPage from "./RepositoriesPage";
import { GraspServiceOverview } from "./RelayPage";

const NODE_RELAY_URL = "wss://git.buildinelsalvador.com";
const NODE_RELAY_LABEL = "git.buildinelsalvador.com";

const Index = () => {
  const account = useActiveAccount();

  if (account) {
    return <Dashboard />;
  }

  return (
    <div className="min-h-full">
      <div className="container max-w-screen-xl px-4 md:px-8 pt-10 pb-6 space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">BIES Code</h1>
        <p className="text-muted-foreground">
          Decentralized git hosting — a Build in El Salvador node
        </p>
        <Link
          to="/landing"
          className="inline-block text-sm text-primary hover:underline"
        >
          What is this?
        </Link>
      </div>
      <RepositoriesPage
        relayOverride={[NODE_RELAY_URL]}
        relayLabel={NODE_RELAY_LABEL}
        relayStatusBanner={
          <GraspServiceOverview
            relayUrl={NODE_RELAY_URL}
            domain={NODE_RELAY_LABEL}
          />
        }
        seoTitle="BIES Code - Decentralized Git"
      />
    </div>
  );
};

export default Index;
