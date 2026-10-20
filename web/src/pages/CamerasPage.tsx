import { Plus, Upload } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CameraTable } from "../components/CameraTable";
import { Button, PageHeader } from "../components/ui";
import { useAuth } from "../hooks/auth";

export function CamerasPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return (
    <>
      <PageHeader
        title="Cameras"
        description="Search, filter and manage registered cameras."
        actions={
          can("cameras:write") && (
            <>
              <Button icon={<Upload className="h-4 w-4" />} onClick={() => navigate("/cameras/import")}>
                Import CSV
              </Button>
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => navigate("/cameras/new")}>
                Add camera
              </Button>
            </>
          )
        }
      />
      <CameraTable initialStatus={params.get("status") ?? ""} initialRecording={params.get("recording") ?? ""} />
    </>
  );
}
