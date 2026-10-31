/**
 * Ambient declarations for globals Spicetify injects at runtime.
 *
 * spicetify-creator does not provide these types, and `@types/spotify-api` (a
 * declared dependency) only covers the Spotify Web API. Without this file
 * `tsc --noEmit` fails on every `Spicetify.*` reference, which makes the
 * typecheck unusable; see issue #2.
 */

declare namespace Spicetify {
  type PlayerTrack = {
    name?: string;
    uri: string;
    duration?: { milliseconds: number };
    artists?: { name: string }[];
    album?: { name: string };
    metadata: Record<string, any>;
  };

  interface PlayerData {
    item?: PlayerTrack;
  }

  namespace Player {
    function getData(): PlayerData;
    const data: PlayerData;
    function addEventListener(
      event: string,
      handler: () => void | Promise<void>,
    ): void;
  }

  function showNotification(
    message: string,
    isError?: boolean,
    durationMs?: number,
  ): void;

  namespace PopupModal {
    function display(options: {
      title?: string;
      content: unknown;
      isLarge?: boolean;
    }): void;
    function hide(): void;
  }

  namespace Topbar {
    class Button {
      constructor(label: string, icon: string, onClick: () => void);
    }
  }

  namespace CosmosAsync {
    function get<T = unknown>(url: string): Promise<T>;
  }
}
