"use client";

import { useRouter } from "next/navigation";

import { createListAction, type ListVisibility } from "@/lib/lists";

import { ListForm } from "./list-form";

export function CreateListForm() {
  const router = useRouter();

  async function handleSubmit(name: string, description: string, visibility: ListVisibility) {
    const result = await createListAction(name, description, visibility);
    if (!result.ok) throw result.message;
    router.push(`/lists/${result.data.id}`);
  }

  return (
    <ListForm
      submitLabel="Create list"
      onSubmit={handleSubmit}
      onCancel={() => router.back()}
    />
  );
}
