import { WorkflowProvider } from "@/lib/workflow-context"
import { Workflow } from "@/components/workflow"

export default function Page() {
  return (
    <WorkflowProvider>
      <Workflow />
    </WorkflowProvider>
  )
}
