import { getBusinessCategoryPreset } from '../domain/businessCategories';
import { useAuth } from '../store/AuthStore';

export const useBusinessCategoryPreset = () => {
  const { session } = useAuth();
  return getBusinessCategoryPreset(session?.businessCategory);
};
