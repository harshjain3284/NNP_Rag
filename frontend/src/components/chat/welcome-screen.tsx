"use client";

import React, { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";

const GREETING_TEMPLATES = [
  (name?: string | null) =>
    name ? `Hello ${name}, ready to explore your documents?` : "Ready to explore your documents?",
  (name?: string | null) =>
    name ? `Welcome, ${name}! What insights are we extracting today?` : "What insights are we extracting from your documents today?",
  (name?: string | null) =>
    name ? `Hello ${name}, what shall we uncover from your knowledge base?` : "What shall we uncover from your knowledge base?",
  (name?: string | null) =>
    name ? `Good to see you, ${name}. What can I find across your files?` : "What can I find across your documents today?",
  (name?: string | null) =>
    name ? `Hello ${name}, your documents are indexed and ready — what's on your mind?` : "Your documents are indexed and ready — what's on your mind?",
  (name?: string | null) =>
    name ? `Welcome back, ${name}! What questions do you have from your sources?` : "What questions do you have from your sources today?",
  (name?: string | null) =>
    name ? `Hello ${name}, let's find the answers hidden in your documents.` : "Let's find the answers hidden in your documents.",
  (name?: string | null) =>
    name ? `Hi ${name}, how can I help you synthesize your knowledge base today?` : "How can I help you synthesize your knowledge base today?",
];

interface WelcomeScreenProps {
  userName?: string | null;
  onSelectSuggestion?: (prompt: string) => void;
}

export function WelcomeScreen({ userName }: WelcomeScreenProps) {
  const { user } = useAuth();
  const displayName = userName ?? user?.name ?? null;

  const [templateIndex, setTemplateIndex] = useState(0);

  useEffect(() => {
    // Select a random greeting on client mount to prevent SSR hydration mismatch
    const randomIndex = Math.floor(Math.random() * GREETING_TEMPLATES.length);
    setTemplateIndex(randomIndex);
  }, []);

  const template = GREETING_TEMPLATES[templateIndex] ?? GREETING_TEMPLATES[0]!;
  const greeting = template(displayName);

  return (
    <div className="w-full max-w-2xl flex-1 flex flex-col items-center justify-center my-auto text-center px-4">
      <h1 className="text-3xl sm:text-4xl font-semibold text-white tracking-tight mb-3">
        {greeting}
      </h1>
      <p className="text-zinc-400 text-sm sm:text-base max-w-md mx-auto">
        Ask anything from your sources.
      </p>
    </div>
  );
}


