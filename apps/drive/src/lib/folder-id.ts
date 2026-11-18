export const isFolderId = (id: string) => id.length > 0 && id.length <= 128 && id !== '.' && id !== '..';
