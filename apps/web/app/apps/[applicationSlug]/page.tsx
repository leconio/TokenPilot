import { redirect } from "next/navigation";

export default async function ApplicationPage({
  params,
}: Readonly<{ params: Promise<{ applicationSlug: string }> }>) {
  const { applicationSlug } = await params;
  redirect(`/apps/${applicationSlug}/dashboard`);
}
